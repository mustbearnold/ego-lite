import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-browser-sync-"));
const sourceDir = await mkdtemp(join(tmpdir(), "ego-browser-sync-source-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const syncFile = join(profileDir, "ego-lite-browser-sync.json");
const defaultBrowser = process.env.EGO_LITE_DEFAULT_BROWSER === "1";
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

function writeBookmarks(entries) {
  return writeFile(
    join(sourceDir, "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: entries.map((entry, index) => ({
            type: "url",
            id: String(index + 1),
            name: entry.name,
            url: entry.url,
          })),
        },
      },
    }),
  );
}

async function writeHistory() {
  const database = new DatabaseSync(join(sourceDir, "History"));
  database.exec(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)",
  );
  const visit = Date.parse("2026-08-02T10:00:00.000Z");
  database
    .prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)")
    .run(
      "https://sync.example/",
      "Sync page",
      (visit + 11644473600000) * 1000,
    );
  database.close();
}

try {
  await writeBookmarks([
    { name: "Source one", url: "https://one.example/" },
  ]);
  await writeHistory();
  await writeFile(
    syncFile,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      sourceProfileDir: sourceDir,
      sourceName: "Fixture browser",
      intervalMinutes: 5,
      lastSyncAt: "2020-01-01T00:00:00.000Z",
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
    const initial = await waitFor("initial browser sync state", async () => {
      const state = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.getBrowserState()",
      );
      return (
        state?.browserSync?.status === (defaultBrowser ? "idle" : "ready") &&
        state
      );
    });
    const initialDom = await evaluate(
      connection,
      attached.sessionId,
      "(() => ({bookmarks: document.querySelectorAll('[data-bookmark-url]').length, history: document.querySelectorAll('[data-history-url]').length, status: document.querySelector('#sync-status')?.textContent, source: document.querySelector('#sync-source')?.textContent}))()",
    );
    if (defaultBrowser) {
      assert.equal(initial.browserSync.enabled, true);
      assert.equal(initial.bookmarks.length, 0);
      assert.equal(initial.history.length, 0);
      assert.equal(initialDom.bookmarks, 0);
      assert.equal(initialDom.history, 0);
      assert.match(initialDom.status, /On · every 5 minutes/);
      console.log(
        JSON.stringify({
          automaticSyncSkipped: true,
          bookmarks: initial.bookmarks.length,
          history: initial.history.length,
          executable: packagedExecutable ? "packaged" : "source",
        }),
      );
    } else {
      assert.equal(initial.browserSync.enabled, true);
      assert.equal(initial.bookmarks.length, 1);
      assert.equal(initial.history.length, 1);
      assert.equal(initialDom.bookmarks, 1);
      assert.equal(initialDom.history, 1);
      assert.match(initialDom.status, /Synced 1 bookmarks/);
      assert.equal(initialDom.source, "Source · Fixture browser");

      await writeBookmarks([
        { name: "Source one", url: "https://one.example/" },
        { name: "Source two", url: "https://two.example/" },
      ]);
      const manual = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.syncBrowserData()",
      );
      assert.equal(manual.importedBookmarks, 2);
      const refreshed = await waitFor("manual browser sync DOM", async () => {
        const state = await evaluate(
          connection,
          attached.sessionId,
          "window.egoLite.getBrowserState()",
        );
        return state.bookmarks.length === 2 ? state : null;
      });
      assert.equal(refreshed.browserSync.status, "ready");

      const disabled = await evaluate(
        connection,
        attached.sessionId,
        "window.egoLite.setBrowserSync({enabled: false})",
      );
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.status, "disabled");

      console.log(
        JSON.stringify({
          initialBookmarks: initial.bookmarks.length,
          initialHistory: initial.history.length,
          manualBookmarks: refreshed.bookmarks.length,
          source: refreshed.browserSync.sourceName,
          executable: packagedExecutable ? "packaged" : "source",
        }),
      );
    }
  } finally {
    connection.close();
  }
} catch (error) {
  throw new Error(`${error.message}\nElectron output:\n${electron?.output() || ""}`);
} finally {
  await stopElectron(electron);
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
