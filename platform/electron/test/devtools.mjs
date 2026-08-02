import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-devtools-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
let electron;
const execFileAsync = promisify(execFile);

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

async function readWindowId() {
  try {
    const { stdout } = await execFileAsync("xdotool", [
      "search",
      "--onlyvisible",
      "--name",
      "^ego lite$",
    ]);
    return stdout.trim().split(/\s+/).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

async function sendNativeKey(chord) {
  const windowId = await waitFor("ego lite X11 window", readWindowId);
  await execFileAsync("xdotool", ["windowfocus", "--sync", windowId]);
  await execFileAsync("xdotool", [
    "mousemove",
    "--window",
    windowId,
    "400",
    "300",
  ]);
  await execFileAsync("xdotool", ["click", "1"]);
  await execFileAsync("xdotool", ["key", "--window", windowId, chord]);
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

try {
  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const primary = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });
  const endpoint = await waitFor("browser CDP endpoint", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    await sendNativeKey("F12");
    const f12Open = await waitFor("F12 Developer Tools", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find(
        (candidate) => candidate.targetId === primary.targetId,
      );
      return tab?.devtoolsOpen === true ? tab : null;
    });
    const targetsAfterOpen = await connection.request("Target.getTargets");
    const f12Devtools = targetsAfterOpen.targetInfos?.find((target) =>
      target.url.startsWith("devtools://"),
    );
    assert.ok(f12Devtools, "F12 should create a DevTools target");
    await connection.request("Target.closeTarget", {
      targetId: f12Devtools.targetId,
    });
    const f12Closed = await waitFor("F12 Developer Tools close", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tab = result.tabs?.find(
        (candidate) => candidate.targetId === primary.targetId,
      );
      return tab?.devtoolsOpen === false ? tab : null;
    });

    assert.equal(f12Open.devtoolsOpen, true);
    assert.equal(f12Closed.devtoolsOpen, false);
    console.log(
      JSON.stringify({
        f12Open: f12Open.devtoolsOpen,
        f12Closed: f12Closed.devtoolsOpen,
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
  await rm(profileDir, { recursive: true, force: true });
}
