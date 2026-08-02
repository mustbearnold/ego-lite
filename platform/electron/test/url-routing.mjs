import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-url-routing-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const statePath = join(profileDir, "task-spaces.json");
await writeFile(
  statePath,
  `${JSON.stringify(
    {
      version: 1,
      nextId: 2,
      spaces: [
        {
          id: 1,
          taskId: "url-routing",
          name: "url routing",
          createdBy: "agent",
          ownership: "agent",
          createdAt: new Date().toISOString(),
          contextId: null,
          mode: "tab",
          tabTargetIds: [],
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const environment = {
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
};

const child = spawn(electronPath, electronArguments, {
  cwd: repoDir,
  env: environment,
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
  if (!response.ok) throw new Error(payload.error || pathname);
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

async function attachTarget(connection, targetId) {
  const result = await connection.request("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return result.sessionId;
}

try {
  const bridge = await waitFor("Electron bridge", readBridge);
  const initial = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });
  const task = await bridgeRequest(bridge, "/create-tab", {
    spaceId: 1,
    spaceName: "url routing",
    url: "about:blank",
  });
  await bridgeRequest(bridge, "/activate-tab", { targetId: task.targetId });

  const endpoint = await waitFor("Electron CDP endpoint", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    const renderer = await waitFor("toolbar target", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const rendererSession = await attachTarget(connection, renderer.targetId);
    const regularUrl =
      "data:text/html,%3Ctitle%3ERegular%20navigation%3C%2Ftitle%3E";
    await evaluate(
      connection,
      rendererSession,
      `window.egoLite.navigate(${JSON.stringify(regularUrl)})`,
    );
    const regular = await waitFor("regular navigation tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const created = result.tabs?.find(
        (tab) => tab.spaceId === null && tab.url === regularUrl,
      );
      const taskTab = result.tabs?.find(
        (tab) => tab.targetId === task.targetId,
      );
      return created && taskTab?.url === "about:blank" ? result : null;
    });
    const regularTab = regular.tabs.find((tab) => tab.url === regularUrl);
    assert.equal(regularTab.active, true);

    const taskSession = await attachTarget(connection, task.targetId);
    const taskPopupUrl =
      "data:text/html,%3Ctitle%3ETask%20popup%3C%2Ftitle%3E";
    await evaluate(
      connection,
      taskSession,
      `window.open(${JSON.stringify(taskPopupUrl)}, "_blank")`,
    );
    const taskPopup = await waitFor("task popup tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const popup = result.tabs?.find((tab) => tab.url === taskPopupUrl);
      return popup ? result : null;
    });
    const taskPopupTab = taskPopup.tabs.find(
      (tab) => tab.url === taskPopupUrl,
    );
    assert.equal(taskPopupTab.spaceId, 1);
    assert.equal(taskPopupTab.active, false);
    assert.equal(
      taskPopup.tabs.find((tab) => tab.targetId === regularTab.targetId).active,
      true,
    );

    const primarySession = await attachTarget(connection, regularTab.targetId);
    const primaryPopupUrl =
      "data:text/html,%3Ctitle%3EPrimary%20popup%3C%2Ftitle%3E";
    await evaluate(
      connection,
      primarySession,
      `window.open(${JSON.stringify(primaryPopupUrl)}, "_blank")`,
    );
    const primaryPopup = await waitFor("primary popup tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const popup = result.tabs?.find((tab) => tab.url === primaryPopupUrl);
      return popup ? result : null;
    });
    const primaryPopupTab = primaryPopup.tabs.find(
      (tab) => tab.url === primaryPopupUrl,
    );
    assert.equal(primaryPopupTab.spaceId, null);
    assert.equal(primaryPopupTab.active, true);

    console.log(
      JSON.stringify({
        regularNavigationStayedOutOfSpace: regularTab.spaceId === null,
        taskPopupSpaceId: taskPopupTab.spaceId,
        taskPopupStayedBackground: taskPopupTab.active === false,
        primaryPopupActivated: primaryPopupTab.active,
        executable: packagedExecutable ? "packaged" : "source",
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  error.message = `${error.message}\n${stdout}\n${stderr}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    child.once("close", resolvePromise);
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
  });
  await rm(profileDir, { recursive: true, force: true });
}
