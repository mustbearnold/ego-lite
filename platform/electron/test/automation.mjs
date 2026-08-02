import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const hostPath = resolve(repoDir, "platform/linux/ego-browser.mjs");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-automation-"));
const statePath = join(profileDir, "task-spaces.json");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");

let electron;
let fixtureServer;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(label, callback, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function readBridge() {
  return JSON.parse(await readFile(bridgeFile, "utf8"));
}

async function bridgeRequest(bridge, pathname, body = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ego-lite-token": bridge.token,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `bridge request failed: ${pathname}`);
  }
  return payload;
}

function startElectron() {
  const child = spawn(electronPath, ["platform/electron"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
      EGO_LITE_DISABLE_AUTO_UPDATE: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      WAYLAND_DISPLAY: "",
      XDG_SESSION_TYPE: "x11",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, output: () => `${stdout}\n${stderr}` };
}

async function stopElectron(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  instance.child.kill("SIGTERM");
  await waitFor(
    "Electron shutdown",
    async () =>
      instance.child.exitCode !== null || instance.child.signalCode !== null,
    5_000,
  ).catch(() => instance.child.kill("SIGKILL"));
}

async function runAutomation(request) {
  const child = spawn(process.execPath, [hostPath, "--automation"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_DISABLE_GPU: "1",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      WAYLAND_DISPLAY: "",
      XDG_SESSION_TYPE: "x11",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(
    lines.length,
    1,
    `automation must write one JSON line; stdout=${JSON.stringify(stdout)} stderr=${stderr}`,
  );
  return { response: JSON.parse(lines[0]), exitCode, stderr };
}

async function automation(request) {
  const result = await runAutomation(request);
  assert.equal(
    result.exitCode,
    0,
    `automation failed: ${JSON.stringify(result.response)} stderr=${result.stderr}`,
  );
  assert.equal(result.response.ok, true, JSON.stringify(result.response));
  return result.response.result;
}

function pageUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

try {
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      nextId: 2,
      spaces: [
        {
          taskId: "automation-space",
          id: 1,
          name: "Automation Space",
          createdBy: "agent",
          ownership: "agent",
          createdAt: new Date().toISOString(),
          contextId: null,
          mode: "tab",
          tabTargetIds: [],
        },
      ],
    })}\n`,
  );
  fixtureServer = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const pages = {
      "/one": ["Automation One", "AUTOMATION_ONE"],
      "/two": ["Automation Two", "AUTOMATION_TWO"],
      "/space": ["Automation Space Tab", "AUTOMATION_SPACE"],
    };
    const [title, marker] = pages[path] || ["Automation Blank", "AUTOMATION_BLANK"];
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><main>${marker}</main>`);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    fixtureServer.once("error", rejectPromise);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = fixtureServer.address().port;
  const oneUrl = pageUrl(port, "/one");
  const twoUrl = pageUrl(port, "/two");
  const spaceUrl = pageUrl(port, "/space");

  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  await waitFor("initial primary tab", async () => {
    const state = await bridgeRequest(bridge, "/automation", {
      version: 1,
      action: "state",
    });
    return state.ok && state.result.tabs.filter((tab) => tab.spaceId === null).length === 1;
  });

  const initial = await automation({ version: 1, action: "state" });
  assert.equal(initial.window.id, "main");
  assert.equal(initial.capabilities.fullWindowInventory, true);
  assert.equal(initial.tabs.filter((tab) => tab.spaceId === null).length, 1);
  assert.equal(initial.taskSpaces[0].name, "Automation Space");

  const listed = await automation({ version: 1, action: "tabs.list" });
  assert.equal(listed.tabs.length, initial.tabs.length);
  const spaces = await automation({ version: 1, action: "spaces.list" });
  assert.equal(spaces.taskSpaces[0].id, 1);

  const created = await automation({
    version: 1,
    action: "tab.create",
    params: { url: oneUrl },
  });
  const primaryTab = created.tab;
  assert.ok(primaryTab?.id);
  assert.equal(primaryTab.active, true);
  assert.equal(primaryTab.url, oneUrl);

  await automation({
    version: 1,
    action: "tab.navigate",
    params: { id: primaryTab.id, url: twoUrl, activate: true },
  });
  await waitFor("navigated primary tab", async () => {
    const result = await automation({ version: 1, action: "tabs.list" });
    return result.tabs.find((tab) => tab.id === primaryTab.id)?.url === twoUrl;
  });

  const muted = await automation({
    version: 1,
    action: "tab.mute",
    params: { id: primaryTab.id, muted: true },
  });
  assert.equal(muted.state.tabs.find((tab) => tab.id === primaryTab.id).muted, true);
  await automation({
    version: 1,
    action: "tab.back",
    params: { id: primaryTab.id },
  });
  await waitFor("back navigation", async () => {
    const result = await automation({ version: 1, action: "tabs.list" });
    return result.tabs.find((tab) => tab.id === primaryTab.id)?.url === oneUrl;
  });
  await automation({ version: 1, action: "tab.forward", params: { id: primaryTab.id } });
  await waitFor("forward navigation", async () => {
    const result = await automation({ version: 1, action: "tabs.list" });
    return result.tabs.find((tab) => tab.id === primaryTab.id)?.url === twoUrl;
  });

  const taskTab = await automation({
    version: 1,
    action: "tab.create",
    params: { spaceId: 1, url: spaceUrl },
  });
  assert.equal(taskTab.tab.spaceId, 1);
  assert.equal(taskTab.tab.active, false);
  await automation({ version: 1, action: "tab.activate", params: { id: taskTab.tab.id } });
  const activatedTask = await automation({ version: 1, action: "state" });
  assert.equal(activatedTask.activeTabId, taskTab.tab.id);
  await automation({ version: 1, action: "tab.close", params: { id: taskTab.tab.id } });

  const added = await automation({
    version: 1,
    action: "bookmark.add",
    params: { url: oneUrl, name: "Automation One" },
  });
  assert.equal(added.added, true);
  assert.equal(added.bookmarks[0].name, "Automation One");
  const bookmark = added.bookmarks[0];
  const opened = await automation({
    version: 1,
    action: "bookmark.open",
    params: { id: bookmark.id },
  });
  assert.equal(opened.bookmark.id, bookmark.id);
  assert.equal(opened.state.tabs.find((tab) => tab.active).url, oneUrl);
  const toggledOff = await automation({
    version: 1,
    action: "bookmark.toggle",
  });
  assert.equal(toggledOff.bookmarked, false);
  const toggledOn = await automation({
    version: 1,
    action: "bookmark.toggle",
  });
  assert.equal(toggledOn.bookmarked, true);
  const removed = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: bookmark.id },
  });
  assert.equal(removed.removed, 1);
  assert.equal(removed.bookmarks.some((candidate) => candidate.id === bookmark.id), false);

  const invalid = await runAutomation({ version: 99, action: "state" });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.response.ok, false);
  assert.equal(invalid.response.error.code, "EGO_AUTOMATION_UNSUPPORTED_VERSION");

  console.log("automation contract: passed");
} finally {
  await stopElectron(electron);
  fixtureServer?.close();
  await rm(profileDir, { recursive: true, force: true });
}
