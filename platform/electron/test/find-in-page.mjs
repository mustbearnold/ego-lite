import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
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
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-find-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const execFileAsync = promisify(execFile);
let electron;
let server;

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
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "DOM evaluation failed");
  }
  return result.result?.value;
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

async function sendNativeFindShortcut() {
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
  await execFileAsync("xdotool", ["key", "--window", windowId, "ctrl+f"]);
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
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>find fixture</title><main>parity one<br>parity two<br>parity three</main>",
    );
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/`;

  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const primary = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });
  const endpoint = await waitFor("browser CDP endpoint", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    const browserAttached = await connection.request("Target.attachToTarget", {
      targetId: primary.targetId,
      flatten: true,
    });
    await connection.request(
      "Page.navigate",
      { url: fixtureUrl },
      browserAttached.sessionId,
    );
    const renderer = await waitFor("toolbar target", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const toolbarAttached = await connection.request("Target.attachToTarget", {
      targetId: renderer.targetId,
      flatten: true,
    });

    await sendNativeFindShortcut();
    const focused = await waitFor("native find focus", async () =>
      evaluate(
        connection,
        toolbarAttached.sessionId,
        "document.activeElement?.id === 'find-input' && !document.querySelector('#find-bar').hidden",
      ),
    );
    await evaluate(
      connection,
      toolbarAttached.sessionId,
      "(() => { const input = document.querySelector('#find-input'); input.value = 'parity'; input.dispatchEvent(new Event('input', {bubbles: true})); return true; })()",
    );
    const first = await waitFor("first find result", async () => {
      const value = await evaluate(
        connection,
        toolbarAttached.sessionId,
        "document.querySelector('#find-count').textContent",
      );
      return value === "1 of 3" ? value : null;
    });
    await evaluate(
      connection,
      toolbarAttached.sessionId,
      "document.querySelector('#find-next').click(); true",
    );
    const second = await waitFor("next find result", async () => {
      const value = await evaluate(
        connection,
        toolbarAttached.sessionId,
        "document.querySelector('#find-count').textContent",
      );
      return value === "2 of 3" ? value : null;
    });
    await evaluate(
      connection,
      toolbarAttached.sessionId,
      "document.querySelector('#find-previous').click(); true",
    );
    const previous = await waitFor("previous find result", async () => {
      const value = await evaluate(
        connection,
        toolbarAttached.sessionId,
        "document.querySelector('#find-count').textContent",
      );
      return value === "1 of 3" ? value : null;
    });
    await evaluate(
      connection,
      toolbarAttached.sessionId,
      "document.querySelector('#find-close').click(); true",
    );
    const closed = await waitFor("find close", async () =>
      evaluate(
        connection,
        toolbarAttached.sessionId,
        "document.querySelector('#find-bar').hidden",
      ),
    );
    console.log(
      JSON.stringify({
        nativeShortcutFocused: focused,
        first,
        second,
        previous,
        closed,
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
  server?.close();
  await rm(profileDir, { recursive: true, force: true });
}
