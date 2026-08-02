import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBookmarks } from "../bookmarks.mjs";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-bookmarks-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const bookmarkPath = join(profileDir, "Default", "Bookmarks");
const pageServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Bookmark fixture</title><h1>Bookmark fixture</h1>");
});
await new Promise((resolvePromise) => pageServer.listen(0, "127.0.0.1", resolvePromise));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/fixture`;
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
      EGO_LITE_SKIP_MIGRATION: "1",
      EGO_LITE_DISABLE_AUTO_UPDATE: "1",
      EGO_LITE_DISABLE_GPU: "1",
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
  if (!response.ok) throw new Error(payload.error || pathname);
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
  const tab = await bridgeRequest(bridge, "/create-tab", {
    spaceId: null,
    url: pageUrl,
  });
  await bridgeRequest(bridge, "/activate-tab", { targetId: tab.targetId });
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
    const initial = await waitFor("bookmark control", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return state?.bookmarkCanToggle && state;
    });
    const initialDom = await evaluate(
      connection,
      attached.sessionId,
      "(() => ({text: document.querySelector('#bookmark-page')?.textContent, disabled: document.querySelector('#bookmark-page')?.disabled}))()",
    );
    assert.equal(initial.bookmarked, false);
    assert.deepEqual(initialDom, { text: "☆", disabled: false });

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#bookmark-page')?.click(); true",
    );
    const added = await waitFor("bookmark add", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return state?.bookmarked ? state : null;
    });
    assert.equal(added.bookmarks.some((bookmark) => bookmark.url === pageUrl), true);
    assert.equal(readBookmarks(bookmarkPath).some((bookmark) => bookmark.url === pageUrl), true);

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#bookmark-page')?.click(); true",
    );
    const removed = await waitFor("bookmark removal", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return state?.bookmarked === false ? state : null;
    });
    assert.equal(removed.bookmarks.some((bookmark) => bookmark.url === pageUrl), false);
    assert.equal(readBookmarks(bookmarkPath).some((bookmark) => bookmark.url === pageUrl), false);

    const task = await bridgeRequest(bridge, "/create-tab", {
      spaceId: 7,
      spaceName: "bookmark guard",
      url: pageUrl,
    });
    await bridgeRequest(bridge, "/activate-tab", { targetId: task.targetId });
    const taskState = await waitFor("Agent bookmark guard", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return state?.controlState?.scope === "space" ? state : null;
    });
    assert.equal(taskState.bookmarkCanToggle, false);
    await bridgeRequest(bridge, "/close-tab", { targetId: task.targetId });
    await evaluate(
      connection,
      attached.sessionId,
      "window.egoLite.newPrivateTab()",
    );
    const privateState = await waitFor("private bookmark guard", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return state?.tabs?.find((tab) => tab.active)?.private ? state : null;
    });
    assert.equal(privateState.bookmarkCanToggle, false);
    await evaluate(connection, attached.sessionId, "window.egoLite.closeTab()");

    console.log(
      JSON.stringify({
        pageUrl,
        initialDom,
        added: true,
        removed: true,
        taskGuard: taskState.bookmarkCanToggle === false,
        privateGuard: privateState.bookmarkCanToggle === false,
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
  pageServer.close();
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
