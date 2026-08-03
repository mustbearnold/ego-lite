import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = resolve(repoDir, "platform/linux/ego-browser.mjs");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const profileRoot = await mkdtemp(join(tmpdir(), "ego-linux-automation-"));
const profileDir = join(profileRoot, "chromium-profile");
const statePath = join(profileRoot, "task-spaces.json");

let fixtureServer;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(label, callback, timeoutMs = 20_000) {
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

async function runAutomation(request) {
  const child = spawn(process.execPath, [hostPath, "--automation"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_HEADLESS: "1",
      EGO_BROWSER_EXECUTABLE: executable,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`standalone automation timed out\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(
    lines.length,
    1,
    `standalone automation must write one JSON line\nstdout=${stdout}\nstderr=${stderr}`,
  );
  return { response: JSON.parse(lines[0]), exitCode, stderr };
}

async function automation(request) {
  const result = await runAutomation(request);
  assert.equal(result.exitCode, 0, JSON.stringify(result.response));
  assert.equal(result.response.ok, true, JSON.stringify(result.response));
  return result.response.result;
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, rejectPromise) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", rejectPromise, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
    return this;
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function closeChromium() {
  let endpoint;
  try {
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8"))
      .trim()
      .split(/\r?\n/);
    endpoint = `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return;
  }
  const connection = await new CdpConnection(endpoint).connect();
  try {
    await connection.request("Browser.close");
  } finally {
    connection.close();
  }
}

try {
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Standalone automation</title><main>STANDALONE_AUTOMATION</main>");
  });
  await new Promise((resolvePromise, rejectPromise) => {
    fixtureServer.once("error", rejectPromise);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
  const savedPath = join(profileRoot, "artifacts", "standalone-page.html");
  const printedPath = join(profileRoot, "artifacts", "standalone-page.pdf");

  const initial = await automation({ version: 1, action: "state" });
  assert.equal(initial.capabilities.fullWindowInventory, false);
  assert.equal(initial.window.index, 1);
  assert.equal(initial.window.activeTabIndex, 1);
  assert.equal(initial.window.mode, "normal");
  assert.equal(initial.window.closeable, null);
  assert.equal(initial.tabs.length, 1);

  const created = await automation({
    version: 1,
    action: "tab.create",
    params: { url: fixtureUrl },
  });
  assert.ok(created.tab.targetId);
  const tabId = created.tab.targetId;
  await automation({
    version: 1,
    action: "tab.navigate",
    params: { id: tabId, url: fixtureUrl },
  });
  const executed = await automation({
    version: 1,
    action: "tab.execute",
    params: { id: tabId, javascript: "document.title + ':' + document.querySelector('main').textContent" },
  });
  assert.equal(executed.value, "Standalone automation:STANDALONE_AUTOMATION");
  const saved = await automation({
    version: 1,
    action: "tab.save",
    params: { id: tabId, path: savedPath },
  });
  assert.equal(saved.saved, true);
  assert.match(await readFile(savedPath, "utf8"), /STANDALONE_AUTOMATION/);
  const printed = await automation({
    version: 1,
    action: "tab.print",
    params: { id: tabId, path: printedPath },
  });
  assert.equal(printed.printed, true);
  assert.equal((await readFile(printedPath)).subarray(0, 4).toString(), "%PDF");
  const source = await automation({
    version: 1,
    action: "tab.view-source",
    params: { id: tabId },
  });
  assert.equal(
    source.state.tabs.find((tab) => tab.id === source.tab.targetId)?.url,
    `view-source:${fixtureUrl}`,
  );
  await automation({ version: 1, action: "tab.close", params: { id: source.tab.targetId } });
  for (const action of ["tab.undo", "tab.redo", "tab.cut", "tab.copy", "tab.paste", "tab.select-all"]) {
    await automation({ version: 1, action, params: { id: tabId } });
  }

  const folderAdded = await automation({
    version: 1,
    action: "bookmark.folder.add",
    params: { title: "Standalone Folder" },
  });
  assert.equal(folderAdded.added, true);
  const nestedBookmark = await automation({
    version: 1,
    action: "bookmark.add",
    params: {
      url: `${fixtureUrl}?nested=1`,
      name: "Standalone nested",
      parentId: folderAdded.folder.id,
    },
  });
  assert.equal(nestedBookmark.bookmark.folderId, folderAdded.folder.id);
  const renamedFolder = await automation({
    version: 1,
    action: "bookmark.folder.rename",
    params: { id: folderAdded.folder.id, title: "Renamed Standalone Folder" },
  });
  assert.equal(renamedFolder.folder.title, "Renamed Standalone Folder");
  const removedNestedBookmark = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: nestedBookmark.bookmark.id },
  });
  assert.equal(removedNestedBookmark.removed, 1);
  const removedFolder = await automation({
    version: 1,
    action: "bookmark.folder.remove",
    params: { id: folderAdded.folder.id },
  });
  assert.equal(removedFolder.removed, 1);

  const added = await automation({
    version: 1,
    action: "bookmark.add",
    params: { url: fixtureUrl, name: "Standalone fixture" },
  });
  assert.equal(added.added, true);
  const bookmark = added.bookmarks[0];
  const opened = await automation({
    version: 1,
    action: "bookmark.open",
    params: { id: bookmark.id },
  });
  assert.equal(opened.bookmark.url, fixtureUrl);
  const toggledOff = await automation({ version: 1, action: "bookmark.toggle" });
  assert.equal(toggledOff.bookmarked, false);
  const toggledOn = await automation({ version: 1, action: "bookmark.toggle" });
  assert.equal(toggledOn.bookmarked, true);
  const removed = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: bookmark.id },
  });
  assert.equal(removed.removed, 1);
  await automation({ version: 1, action: "tab.close", params: { id: tabId } });

  const invalid = await runAutomation({ version: 1, action: "not-real" });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.response.error.code, "EGO_AUTOMATION_UNKNOWN_ACTION");

  console.log("standalone automation contract: passed");
} finally {
  await closeChromium().catch(() => {});
  fixtureServer?.close();
  await rm(profileRoot, { recursive: true, force: true });
}
