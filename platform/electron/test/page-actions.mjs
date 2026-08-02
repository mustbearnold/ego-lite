import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-page-actions-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const savePath = join(profileDir, "artifacts", "saved-page.html");
const printPath = join(profileDir, "artifacts", "printed-page.pdf");
const pageMarker = "PAGE_SOURCE_MARKER_ego_lite";
const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Page action fixture</title></head>
<body><main><h1>Page action fixture</h1><p>${pageMarker}</p></main></body></html>`;

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

async function attachTarget(connection, targetId) {
  return (
    await connection.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    })
  ).sessionId;
}

async function evaluate(connection, sessionId, expression, awaitPromise = false) {
  const result = await connection.request(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise,
      returnByValue: true,
    },
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
      EGO_LITE_SAVE_PATH: savePath,
      EGO_LITE_PRINT_TO_PDF_PATH: printPath,
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

function menuItem(items, label) {
  return items.find((item) => item.label === label);
}

try {
  fixtureServer = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/slow") {
      response.writeHead(200);
      response.write("<!doctype html><title>Slow page</title><p>loading");
      setTimeout(() => response.end("</p>"), 5_000);
      return;
    }
    response.writeHead(200);
    response.end(pageHtml);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    fixtureServer.once("error", rejectPromise);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = fixtureServer.address().port;
  const pageUrl = `http://127.0.0.1:${port}/page`;
  const slowUrl = `http://127.0.0.1:${port}/slow`;

  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const initialTabs = await waitFor("initial primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.filter((tab) => tab.spaceId === null).length === 1
      ? result
      : null;
  });
  const initialTab = initialTabs.tabs.find((tab) => tab.spaceId === null);
  const endpoint = await waitFor("browser CDP endpoint", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();

  try {
    const renderer = await waitFor("toolbar target", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const toolbarSession = await attachTarget(connection, renderer.targetId);
    const controls = await waitFor("page action controls", async () => {
      const result = await evaluate(
        connection,
        toolbarSession,
        `(() => ({
          stop: Boolean(document.querySelector("#stop")),
          pageMenu: Boolean(document.querySelector("#page-menu")),
          save: Boolean(document.querySelector("#save-page")),
          print: Boolean(document.querySelector("#print-page")),
          source: Boolean(document.querySelector("#view-source"))
        }))()`,
      );
      return Object.values(result || {}).every(Boolean) ? result : null;
    });

    const menu = await bridgeRequest(bridge, "/menu");
    const fileMenu = menuItem(menu.items, "File");
    const viewMenu = menuItem(menu.items, "View");
    assert.ok(fileMenu, "native File menu should exist");
    assert.ok(viewMenu, "native View menu should exist");
    for (const label of ["Save Page…", "Print…"]) {
      assert.ok(menuItem(fileMenu.submenu, label), `${label} menu item missing`);
    }
    for (const label of ["Stop", "View Page Source"]) {
      assert.ok(menuItem(viewMenu.submenu, label), `${label} menu item missing`);
    }

    await evaluate(
      connection,
      toolbarSession,
      `window.egoLite.navigate(${JSON.stringify(pageUrl)})`,
      true,
    );
    await waitFor("fixture page", async () => {
      const state = await evaluate(
        connection,
        toolbarSession,
        "window.egoLite.getBrowserState()",
        true,
      );
      return state?.url === pageUrl && !state.loading ? state : null;
    });

    await evaluate(
      connection,
      toolbarSession,
      `document.querySelector("#save-page").click(); true`,
    );
    const saved = await waitFor("saved page", async () => {
      try {
        const contents = await readFile(savePath, "utf8");
        return contents.includes(pageMarker) ? contents : null;
      } catch {
        return null;
      }
    });
    assert.match(saved, new RegExp(pageMarker));

    await evaluate(
      connection,
      toolbarSession,
      `document.querySelector("#print-page").click(); true`,
    );
    const pdf = await waitFor("printed page", async () => {
      try {
        const contents = await readFile(printPath);
        return contents.subarray(0, 4).toString() === "%PDF" ? contents : null;
      } catch {
        return null;
      }
    });
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");

    await evaluate(
      connection,
      toolbarSession,
      `document.querySelector("#view-source").click(); true`,
    );
    const sourceTab = await waitFor("view-source tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      return result.tabs?.find(
        (tab) => tab.active && tab.url === `view-source:${pageUrl}`,
      );
    });
    const sourceSession = await attachTarget(connection, sourceTab.targetId);
    const sourceText = await waitFor("view-source content", async () => {
      const text = await evaluate(
        connection,
        sourceSession,
        "document.documentElement?.innerText || document.body?.innerText || ''",
      );
      return text?.includes(pageMarker) ? text : null;
    });
    assert.match(sourceText, new RegExp(pageMarker));

    await bridgeRequest(bridge, "/activate-tab", {
      targetId: initialTab.targetId,
    });
    await waitFor("original tab active", async () => {
      const state = await evaluate(
        connection,
        toolbarSession,
        "window.egoLite.getBrowserState()",
        true,
      );
      return state?.tabs?.find(
        (tab) => tab.targetId === initialTab.targetId && tab.active,
      );
    });
    await evaluate(
      connection,
      toolbarSession,
      `(() => { void window.egoLite.navigate(${JSON.stringify(slowUrl)}).catch(() => {}); return true; })()`,
    );
    await waitFor("slow page loading", async () => {
      const state = await evaluate(
        connection,
        toolbarSession,
        "window.egoLite.getBrowserState()",
        true,
      );
      return state?.url === slowUrl && state.loading ? state : null;
    });
    await waitFor("stop button enabled", async () =>
      evaluate(
        connection,
        toolbarSession,
        "document.querySelector('#stop')?.disabled === false",
      ),
    );
    await evaluate(
      connection,
      toolbarSession,
      `document.querySelector("#stop").click(); true`,
    );
    const stoppedState = await waitFor("slow page stopped", async () => {
      const state = await evaluate(
        connection,
        toolbarSession,
        "window.egoLite.getBrowserState()",
        true,
      );
      return state?.url === slowUrl && !state.loading ? state : null;
    });

    console.log(
      JSON.stringify({
        controls,
        menu: {
          file: fileMenu.submenu.map((item) => item.label),
          view: viewMenu.submenu.map((item) => item.label),
        },
        saved: { path: savePath, bytes: Buffer.byteLength(saved) },
        printed: { path: printPath, bytes: pdf.length },
        viewSource: { targetId: sourceTab.targetId, url: sourceTab.url },
        stopped: { url: stoppedState.url, loading: stoppedState.loading },
      }),
    );
  } finally {
    connection.close();
  }
} catch (error) {
  if (electron) {
    console.error(electron.output());
  }
  throw error;
} finally {
  await stopElectron(electron);
  if (fixtureServer) {
    fixtureServer.closeAllConnections?.();
    await new Promise((resolvePromise) => fixtureServer.close(resolvePromise));
  }
  await rm(profileDir, { recursive: true, force: true });
}
