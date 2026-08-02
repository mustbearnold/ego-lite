import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-tab-groups-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
let electron;

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

  request(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.socket?.close();
  }
}

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

function startElectron() {
  const child = spawn(electronPath, electronArguments, {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
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
    throw new Error(payload.error || `bridge failed: ${pathname}`);
  }
  return payload;
}

async function readEndpoint() {
  try {
    const lines = (
      await readFile(join(profileDir, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.request(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "DOM evaluation failed");
  }
  return result.result?.value;
}

try {
  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const initial = await waitFor("initial primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });
  const created = await bridgeRequest(bridge, "/create-tab", {
    spaceId: null,
    url: "about:blank",
  });
  await bridgeRequest(bridge, "/activate-tab", { targetId: created.targetId });

  const endpoint = await waitFor("Electron renderer CDP", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    const renderer = await waitFor("toolbar target", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const attached = await connection.request("Target.attachToTarget", {
      targetId: renderer.targetId,
      flatten: true,
    });
    const createdId = JSON.stringify(created.targetId);
    const grouped = await evaluate(
      connection,
      attached.sessionId,
      `window.egoLite.setTabGroup({targetId: ${createdId}, title: "Parity group", color: "blue"})`,
    );
    const groupId = grouped.find((tab) => tab.targetId === created.targetId)
      ?.tabGroup?.id;
    assert.ok(groupId, "grouping a primary tab should assign a group id");

    const groupedTabs = await waitFor("grouped primary tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find((candidate) => candidate.targetId === created.targetId);
      return tab?.tabGroup?.id === groupId ? result.tabs : null;
    });
    const groupedToolbar = await waitFor("group toolbar controls", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({button: document.querySelector('#group-tab')?.textContent, menuHidden: document.querySelector('#group-menu')?.hidden, add: !!document.querySelector('[data-group-action=\\\"add-tab\\\"]')}))()",
      );
      return value?.button === "Ungroup" && value.menuHidden === false && value.add
        ? value
        : null;
    });

    await bridgeRequest(bridge, "/activate-tab", {
      targetId: initial.targetId,
    });
    await waitFor("primary tab activation", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      return result.tabs?.find((tab) => tab.targetId === initial.targetId)?.active
        ? result
        : null;
    });
    await waitFor("add-tab group action", async () => {
      const disabled = await evaluate(
        connection,
        attached.sessionId,
        "document.querySelector('[data-group-action=\\\"add-tab\\\"]')?.disabled",
      );
      return disabled === false ? true : null;
    });
    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('[data-group-action=\\\"add-tab\\\"]')?.click(); true",
    );
    const assignedTabs = await waitFor("current tab group assignment", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 2 && tabs.every((tab) => tab.tabGroup?.id === groupId)
        ? tabs
        : null;
    });

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#group-tab')?.click(); true",
    );
    const ungrouped = await waitFor("tab ungroup", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const active = result.tabs?.find((tab) => tab.targetId === initial.targetId);
      const other = result.tabs?.find((tab) => tab.targetId === created.targetId);
      return active?.tabGroup === null && other?.tabGroup?.id === groupId
        ? result.tabs
        : null;
    });

    const task = await bridgeRequest(bridge, "/create-tab", {
      spaceId: 7,
      spaceName: "group guard",
      url: "about:blank",
    });
    const taskError = await evaluate(
      connection,
      attached.sessionId,
      `window.egoLite.setTabGroup({targetId: ${JSON.stringify(task.targetId)}, title: "invalid"}).then(() => "allowed", (error) => error.message)`,
    );
    assert.match(taskError, /normal tabs/);
    await bridgeRequest(bridge, "/close-tab", { targetId: task.targetId });

    console.log(
      JSON.stringify({
        groupId,
        groupedToolbar,
        groupedTabs: groupedTabs.filter((tab) => tab.tabGroup?.id === groupId).length,
        assignedTabs: assignedTabs.length,
        ungrouped: ungrouped.find((tab) => tab.targetId === initial.targetId)?.tabGroup === null,
        taskGuard: taskError,
        executable: packagedExecutable ? "packaged" : "source",
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  throw new Error(`${error.message}\nElectron output:\n${electron?.output() || ""}`);
} finally {
  await stopElectron(electron);
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
