import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-tab-controls-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    "<!doctype html><title>Reopen fixture</title><p>reopen fixture</p>",
  );
});
await new Promise((resolvePromise, rejectPromise) => {
  fixtureServer.once("error", rejectPromise);
  fixtureServer.listen(0, "127.0.0.1", resolvePromise);
});
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/reopen`;
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

function startElectron() {
  const child = spawn(electronPath, ["platform/electron"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
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

async function sendNativeKey(chord) {
  const { stdout } = await execFileAsync("xdotool", [
    "search",
    "--onlyvisible",
    "--name",
    "^ego lite$",
  ]);
  const windowId = stdout.trim().split(/\s+/).filter(Boolean)[0];
  if (!windowId) throw new Error("ego lite X11 window not found");
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
  if (!response.ok)
    throw new Error(payload.error || `bridge failed: ${pathname}`);
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
    return result.tabs?.filter((tab) => tab.spaceId === null).length === 1
      ? result
      : null;
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
    const controls = await waitFor("tab controls", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({newTab: !!document.querySelector('#new-tab'), closeTab: !!document.querySelector('#close-tab')}))()",
      );
      return value?.newTab && value.closeTab ? value : null;
    });
    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'l', ctrlKey: true, bubbles: true, cancelable: true})); true",
    );
    const addressShortcut = await waitFor(
      "address focus shortcut",
      async () => {
        const value = await evaluate(
          connection,
          attached.sessionId,
          "document.activeElement?.id === 'address'",
        );
        return value ? { focused: true } : null;
      },
    );

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#new-tab').click(); true",
    );
    const afterNewTab = await waitFor("new primary tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 2 && tabs.some((tab) => tab.active) ? tabs : null;
    });
    const newTab = afterNewTab.find((tab) => tab.active);
    if (!newTab || newTab.targetId === initial.tabs[0].targetId) {
      throw new Error(
        `new tab was not selected: ${JSON.stringify(afterNewTab)}`,
      );
    }

    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w', ctrlKey: true, bubbles: true, cancelable: true})); true",
    );
    const afterKeyboardClose = await waitFor("keyboard tab close", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 1 ? tabs : null;
    });
    if (afterKeyboardClose[0].targetId !== initial.tabs[0].targetId) {
      throw new Error(
        `keyboard close selected the wrong fallback: ${JSON.stringify(afterKeyboardClose)}`,
      );
    }

    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 't', ctrlKey: true, bubbles: true, cancelable: true})); true",
    );
    const afterKeyboardNew = await waitFor("keyboard new tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 2 ? tabs : null;
    });
    await evaluate(
      connection,
      attached.sessionId,
      `window.egoLite.navigate(${JSON.stringify(fixtureUrl)})`,
    );
    const navigatedTab = await waitFor("fixture navigation", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      return result.tabs?.find(
        (tab) => tab.active && tab.url === fixtureUrl,
      );
    });
    await evaluate(
      connection,
      attached.sessionId,
      "window.egoLite.setTabGroup({title: 'Reopen group', color: 'blue'})",
    );
    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w', ctrlKey: true, bubbles: true, cancelable: true})); true",
    );
    const afterFixtureClose = await waitFor("fixture tab close", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 1 && tabs[0].url !== fixtureUrl ? tabs : null;
    });
    const canReopen = await evaluate(
      connection,
      attached.sessionId,
      "window.egoLite.getBrowserState().then((state) => state.canReopenClosedTab === true)",
    );
    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 't', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})); true",
    );
    const afterReopen = await waitFor("reopened tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 2 && tabs.some(
        (tab) => tab.active && tab.url === fixtureUrl,
      )
        ? tabs
        : null;
    });
    const reopenedTab = afterReopen.find((tab) => tab.active);
    if (
      reopenedTab?.tabGroup?.title !== "Reopen group" ||
      reopenedTab?.tabGroup?.color !== "blue"
    ) {
      throw new Error(
        `reopened tab lost its group: ${JSON.stringify(reopenedTab)}`,
      );
    }
    const canReopenAfterReopen = await evaluate(
      connection,
      attached.sessionId,
      "window.egoLite.getBrowserState().then((state) => state.canReopenClosedTab === false)",
    );
    await sendNativeKey("ctrl+w");
    const afterNativeClose = await waitFor("native tab close", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
      return tabs.length === 1 && tabs[0].url !== fixtureUrl ? tabs : null;
    });
    await sendNativeKey("ctrl+shift+t");
    const afterNativeReopen = await waitFor(
      "native reopened tab",
      async () => {
        const result = await bridgeRequest(bridge, "/tabs");
        const tabs = result.tabs?.filter((tab) => tab.spaceId === null) || [];
        return tabs.length === 2 && tabs.some(
          (tab) => tab.active && tab.url === fixtureUrl,
        )
          ? tabs
          : null;
      },
    );
    console.log(
      JSON.stringify({
        controls,
        addressShortcut,
        initialTargetId: initial.tabs[0].targetId,
        afterNewTab: afterNewTab.map((tab) => ({
          targetId: tab.targetId,
          active: tab.active,
        })),
        afterKeyboardClose,
        keyboardNewTabCount: afterKeyboardNew.length,
        navigatedTargetId: navigatedTab.targetId,
        afterFixtureClose,
        canReopen,
        reopenedUrl: reopenedTab?.url,
        reopenedGroup: reopenedTab?.tabGroup,
        canReopenAfterReopen,
        afterNativeClose,
        nativeReopenedUrl: afterNativeReopen.find((tab) => tab.active)?.url,
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  throw new Error(
    `${error.message}\nElectron output:\n${electron?.output() || ""}`,
  );
} finally {
  await stopElectron(electron);
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise));
}
