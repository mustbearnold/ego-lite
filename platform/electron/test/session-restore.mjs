import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-session-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const sessionFile = join(profileDir, "ego-lite-session.json");
let first;
let second;

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
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
      });
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
  const child = spawn(electronPath, ["platform/electron"], {
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
  if (!response.ok) throw new Error(payload.error || `bridge failed: ${pathname}`);
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

async function readSession() {
  return JSON.parse(await readFile(sessionFile, "utf8"));
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
  first = startElectron();
  const firstBridge = await waitFor("first Electron bridge", readBridge);
  await waitFor("primary session tab", async () => {
    const result = await bridgeRequest(firstBridge, "/tabs");
    return result.tabs?.some((tab) => tab.spaceId === null) ? result : null;
  });

  const one = await bridgeRequest(firstBridge, "/create-tab", {
    spaceId: null,
    url: "https://example.com/session-one",
  });
  const two = await bridgeRequest(firstBridge, "/create-tab", {
    spaceId: null,
    url: "https://example.com/session-two",
  });
  await bridgeRequest(firstBridge, "/activate-tab", { targetId: two.targetId });
  const saved = await waitFor("primary session manifest", async () => {
    const manifest = await readSession();
    return manifest.tabs?.some((tab) => tab.url.includes("session-two"))
      ? manifest
      : null;
  });
  const savedUrls = saved.tabs
    .filter((tab) => tab.url.includes("example.com/session-"))
    .map((tab) => tab.url)
    .sort();
  if (
    savedUrls.length !== 2 ||
    !savedUrls[0].includes("session-one") ||
    !savedUrls[1].includes("session-two") ||
    !saved.tabs.find((tab) => tab.url.includes("session-two"))?.active
  ) {
    throw new Error(`primary session was not saved: ${JSON.stringify(saved)}`);
  }
  await stopElectron(first);

  second = startElectron();
  const secondBridge = await waitFor("second Electron bridge", readBridge);
  const restored = await waitFor("restored primary tabs", async () => {
    const result = await bridgeRequest(secondBridge, "/tabs");
    return result.tabs?.filter((tab) =>
      tab.url.includes("example.com/session-"),
    ).length === 2
      ? result
      : null;
  });
  const restoredTabs = restored.tabs.filter((tab) =>
    tab.url.includes("example.com/session-"),
  );
  if (
    !restoredTabs.some(
      (tab) => tab.url.includes("session-one") && !tab.active,
    ) ||
    !restoredTabs.some((tab) => tab.url.includes("session-two") && tab.active)
  ) {
    throw new Error(`primary session was not restored: ${JSON.stringify(restored)}`);
  }

  const connection = await waitFor("Electron renderer CDP", async () => {
    const endpoint = await readEndpoint();
    if (!endpoint) return null;
    const candidate = new CdpConnection(endpoint);
    try {
      return await candidate.connect();
    } catch {
      candidate.close();
      return null;
    }
  });
  try {
    const renderer = await waitFor("restored toolbar DOM", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const attached = await connection.request("Target.attachToTarget", {
      targetId: renderer.targetId,
      flatten: true,
    });
    const toolbar = await waitFor("restored toolbar options", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({count: document.querySelectorAll('#tab-picker option').length, selected: document.querySelector('#tab-picker option:checked')?.textContent || ''}))()",
      );
      return value?.count >= 3
        ? value
        : null;
    });
    console.log(
      JSON.stringify({
        savedUrls,
        restoredUrls: restoredTabs.map((tab) => tab.url).sort(),
        toolbar,
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  const output = [first, second]
    .map((instance, index) => (instance ? `Electron ${index + 1}:\n${instance.output()}` : ""))
    .filter(Boolean)
    .join("\n");
  throw new Error(`${error.message}\n${output}`);
} finally {
  await stopElectron(second);
  await stopElectron(first);
  await rm(profileDir, { recursive: true, force: true });
}
