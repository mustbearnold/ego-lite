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
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-tab-audio-"));
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
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8"))
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
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "DOM evaluation failed");
  }
  return result.result?.value;
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

try {
  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const primary = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });
  assert.equal(primary.muted, false, "user tabs should start unmuted");

  const task = await bridgeRequest(bridge, "/create-tab", {
    spaceId: 1,
    spaceName: "audio parity",
    url: "about:blank",
  });
  const taskState = await waitFor("muted task tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    const tab = result.tabs?.find((candidate) => candidate.targetId === task.targetId);
    return tab?.muted === true ? tab : null;
  });

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
    const toolbar = await waitFor("mute toolbar control", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({exists: !!document.querySelector('#mute-tab'), label: document.querySelector('#mute-tab')?.getAttribute('aria-label'), disabled: document.querySelector('#mute-tab')?.disabled}))()",
      );
      return value?.exists && value.disabled === false ? value : null;
    });

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#mute-tab').click(); true",
    );
    const userMuted = await waitFor("user tab mute", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find((candidate) => candidate.targetId === primary.targetId);
      return tab?.muted === true ? tab : null;
    });

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#mute-tab').click(); true",
    );
    const userUnmuted = await waitFor("user tab unmute", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find((candidate) => candidate.targetId === primary.targetId);
      return tab?.muted === false ? tab : null;
    });

    await bridgeRequest(bridge, "/activate-tab", { targetId: task.targetId });
    const taskToolbar = await waitFor("active task mute label", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({label: document.querySelector('#mute-tab')?.getAttribute('aria-label'), text: document.querySelector('#mute-tab')?.textContent?.trim()}))()",
      );
      return value?.label === "Unmute tab" ? value : null;
    });
    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#mute-tab').click(); true",
    );
    const taskUnmuted = await waitFor("task tab unmute", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find((candidate) => candidate.targetId === task.targetId);
      return tab?.muted === false ? tab : null;
    });

    console.log(
      JSON.stringify({
        primaryStartMuted: primary.muted,
        taskStartMuted: taskState.muted,
        toolbar,
        userMuted: userMuted.muted,
        userUnmuted: userUnmuted.muted,
        taskToolbar,
        taskUnmuted: taskUnmuted.muted,
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  throw new Error(`${error.message}\nElectron output:\n${electron?.output() || ""}`);
} finally {
  await stopElectron(electron);
  await rm(profileDir, { recursive: true, force: true });
}
