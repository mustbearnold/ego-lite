import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArgs = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-private-tabs-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
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

function startElectron() {
  const child = spawn(electronPath, electronArgs, {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
      EGO_LITE_DISABLE_AUTO_UPDATE: "1",
      EGO_LITE_DOWNLOAD_DIR: join(profileDir, "downloads"),
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

async function evaluateTarget(connection, targetId, expression) {
  const attached = await connection.request("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return evaluate(connection, attached.sessionId, expression);
}

async function currentTabs(bridge) {
  return (await bridgeRequest(bridge, "/tabs")).tabs || [];
}

try {
  server = createServer((request, response) => {
    if (request.url === "/download") {
      response.setHeader("content-type", "text/plain");
      response.setHeader(
        "content-disposition",
        'attachment; filename="fixture.txt"',
      );
      response.end("download fixture\n");
      return;
    }
    if (request.url === "/set") {
      response.setHeader("set-cookie", "ego_primary=1; Path=/");
    }
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>private tab fixture</title><a id=download href=/download>download</a>",
    );
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const { port } = server.address();
  const fixtureUrl = `http://127.0.0.1:${port}`;
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeFile(
    join(profileDir, "Default", "Bookmarks"),
    `${JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            {
              type: "url",
              id: "fixture",
              name: "Private fixture",
              url: `${fixtureUrl}/set`,
            },
          ],
        },
      },
    })}\n`,
  );

  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
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
    const toolbarFeatures = await waitFor(
      "toolbar browser controls",
      async () => {
        const value = await evaluate(
          connection,
          attached.sessionId,
          "(() => ({privateTab: !!document.querySelector('#new-private-tab'), bookmarkMenu: !document.querySelector('#bookmark-menu').hidden, bookmarkLabels: [...document.querySelectorAll('#bookmark-list button')].map((button) => button.textContent)}))()",
        );
        return value?.privateTab &&
          value.bookmarkMenu &&
          value.bookmarkLabels?.length
          ? value
          : null;
      },
    );

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#bookmark-list button').click(); true",
    );
    const primary = await waitFor("primary cookie fixture", async () => {
      const tabs = await currentTabs(bridge);
      const tab = tabs.find((candidate) => candidate.spaceId === null);
      if (!tab?.url.endsWith("/set")) return null;
      const cookies = await evaluateTarget(
        connection,
        tab.targetId,
        "document.cookie",
      );
      return cookies.includes("ego_primary=1") ? tab : null;
    });

    await evaluateTarget(
      connection,
      primary.targetId,
      "document.querySelector('#download').click(); true",
    );
    const downloadFeatures = await waitFor("download toolbar", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({visible: !document.querySelector('#download-menu').hidden, labels: [...document.querySelectorAll('#download-list .download-row > span')].map((node) => node.textContent), buttons: [...document.querySelectorAll('#download-list .download-row button')].map((node) => node.textContent)}))()",
      );
      return value?.labels?.some((label) =>
        /fixture\.txt · completed/.test(label),
      )
        ? value
        : null;
    });
    if (!downloadFeatures.buttons.includes("Open")) {
      throw new Error("download toolbar is missing the Open action");
    }
    const downloaded = await readFile(
      join(profileDir, "downloads", "fixture.txt"),
      "utf8",
    );
    if (downloaded !== "download fixture\n") {
      throw new Error(
        `download contents mismatch: ${JSON.stringify(downloaded)}`,
      );
    }

    const historyFeatures = await waitFor("history toolbar", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({visible: !document.querySelector('#history-menu').hidden, urls: [...document.querySelectorAll('#history-list button[data-history-url]')].map((node) => node.dataset.historyUrl), clear: [...document.querySelectorAll('#history-list button')].some((node) => node.textContent === 'Clear history')}))()",
      );
      return value?.urls?.some((url) => url.endsWith("/set")) ? value : null;
    });
    if (!historyFeatures.clear) {
      throw new Error("history toolbar is missing Clear history");
    }
    await evaluate(
      connection,
      attached.sessionId,
      "[...document.querySelectorAll('#history-list button')].find((node) => node.textContent === 'Clear history').click(); true",
    );
    await waitFor("history clear", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "document.querySelector('#history-menu').hidden",
      );
      return value === true ? value : null;
    });

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#reading-list-list button[aria-label=\"Add current page to reading list\"]').click(); true",
    );
    const readingListFeatures = await waitFor(
      "reading list toolbar",
      async () => {
        const value = await evaluate(
          connection,
          attached.sessionId,
          "(() => ({urls: [...document.querySelectorAll('#reading-list-list button[data-reading-list-url]')].map((node) => node.dataset.readingListUrl), addDisabled: document.querySelector('#reading-list-list button[aria-label=\"Add current page to reading list\"]')?.disabled}))()",
        );
        return value?.urls?.some((url) => url.endsWith("/set")) ? value : null;
      },
    );

    await evaluate(
      connection,
      attached.sessionId,
      "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})); true",
    );
    const privateTab = await waitFor("private tab", async () => {
      const tabs = await currentTabs(bridge);
      return tabs.find(
        (tab) => tab.spaceId === null && tab.private && tab.active,
      );
    });
    await evaluate(
      connection,
      attached.sessionId,
      `window.egoLite.navigate(${JSON.stringify(`${fixtureUrl}/read`)})`,
    );
    const privateCookie = await waitFor(
      "private cookie isolation",
      async () => {
        const tabs = await currentTabs(bridge);
        const tab = tabs.find(
          (candidate) => candidate.targetId === privateTab.targetId,
        );
        if (!tab?.url.endsWith("/read")) return null;
        return {
          tab,
          cookies: await evaluateTarget(
            connection,
            tab.targetId,
            "document.cookie",
          ),
        };
      },
    );
    if (privateCookie.cookies !== "") {
      throw new Error(
        `private tab inherited persistent cookies: ${privateCookie.cookies}`,
      );
    }
    const privateReadingList = await evaluate(
      connection,
      attached.sessionId,
      "[...document.querySelectorAll('#reading-list-list button[data-reading-list-url]')].map((node) => node.dataset.readingListUrl)",
    );
    if (privateReadingList.some((url) => url.endsWith("/read"))) {
      throw new Error("private tab was added to the reading list");
    }

    await evaluate(
      connection,
      attached.sessionId,
      "document.querySelector('#close-tab').click(); true",
    );
    const persistentOnly = await waitFor("private tab close", async () => {
      const tabs = await currentTabs(bridge);
      return tabs.length === 1 && !tabs[0].private ? tabs : null;
    });
    await waitFor("persistent session manifest", async () => {
      try {
        const manifest = JSON.parse(
          await readFile(join(profileDir, "ego-lite-session.json"), "utf8"),
        );
        return manifest.tabs?.every((tab) => !tab.private) ? manifest : null;
      } catch {
        return null;
      }
    });
    console.log(
      JSON.stringify({
        primaryTargetId: primary.targetId,
        privateTargetId: privateTab.targetId,
        privateCookie: privateCookie.cookies,
        toolbarFeatures,
        downloadFeatures,
        historyFeatures,
        readingListFeatures,
        persistentOnly: persistentOnly.map((tab) => ({
          private: tab.private,
          url: tab.url,
        })),
      }),
    );
  } finally {
    connection.close();
  }

  await stopElectron(electron);
  electron = startElectron();
  const restartedBridge = await waitFor(
    "restarted Electron bridge",
    readBridge,
  );
  const restored = await waitFor("private tab not restored", async () => {
    const tabs = await currentTabs(restartedBridge);
    return tabs.length === 1 && !tabs[0].private ? tabs : null;
  });
  console.log(JSON.stringify({ restoredTabs: restored.length }));
} catch (error) {
  throw new Error(
    `${error.message}\nElectron output:\n${electron?.output() || ""}`,
  );
} finally {
  await stopElectron(electron);
  if (server)
    await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
