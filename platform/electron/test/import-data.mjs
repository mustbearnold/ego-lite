import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const root = await mkdtemp(join(tmpdir(), "ego-electron-import-data-"));
const sourceUserData = join(root, "source-browser");
const sourceProfile = join(sourceUserData, "Default");
const profileDir = join(root, "ego-profile");
const targetProfile = join(profileDir, "Default");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const pendingImportFile = join(profileDir, "ego-lite-pending-import.json");
let first;
let secondConnection;

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

async function waitFor(label, callback, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(75);
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
      EGO_LITE_IMPORT_SOURCE: sourceUserData,
      EGO_BROWSER_EXECUTABLE: executable,
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
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8"))
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
}

async function connectToRenderer() {
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
  const renderer = await waitFor("Electron toolbar", async () => {
    const targets = await connection.request("Target.getTargets");
    return targets.targetInfos?.find((target) =>
      target.url.includes("/renderer/index.html"),
    );
  });
  const attached = await connection.request("Target.attachToTarget", {
    targetId: renderer.targetId,
    flatten: true,
  });
  return { connection, sessionId: attached.sessionId };
}

async function stopRelaunchedElectron() {
  if (!secondConnection?.connection) return;
  void secondConnection.connection.request("Browser.close").catch(() => {});
  await waitFor(
    "restarted Electron shutdown",
    async () => {
      try {
        await readFile(bridgeFile, "utf8");
        return null;
      } catch (error) {
        return error?.code === "ENOENT" ? true : null;
      }
    },
    5_000,
  ).catch(() => {});
  secondConnection.connection.close();
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
  await mkdir(sourceProfile, { recursive: true });
  await writeFile(
    join(sourceProfile, "Preferences"),
    `${JSON.stringify({ profile: { name: "Imported from settings" } })}\n`,
  );
  await writeFile(
    join(sourceProfile, "Bookmarks"),
    `${JSON.stringify({ roots: {}, version: 1 })}\n`,
  );

  first = startElectron();
  const initialBridge = await waitFor("initial Electron bridge", readBridge);
  await mkdir(targetProfile, { recursive: true });
  await writeFile(join(targetProfile, "Bookmarks"), '{"existing":true}\n');
  const renderer = await connectToRenderer();
  try {
    const importButton = await waitFor("Import data toolbar control", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "(() => ({exists: !!document.querySelector('#import-data'), label: document.querySelector('#import-data')?.textContent.trim()}))()",
      );
      return value?.exists ? value : null;
    });
    if (importButton.label !== "Import") {
      throw new Error(
        `Import data control has unexpected label: ${JSON.stringify(importButton)}`,
      );
    }
    await evaluate(
      renderer.connection,
      renderer.sessionId,
      "document.querySelector('#import-data').click(); true",
    );
  } finally {
    renderer.connection.close();
  }

  await waitFor(
    "initial Electron restart",
    async () => first.child.exitCode !== null || first.child.signalCode !== null,
  );
  const restartedBridge = await waitFor("restarted Electron bridge", async () => {
    try {
      const bridge = await readBridge();
      return bridge.token !== initialBridge.token ? bridge : null;
    } catch {
      return null;
    }
  });
  const importedPreferences = await waitFor(
    "imported browser preferences",
    async () => {
      try {
        const preferences = await readFile(join(targetProfile, "Preferences"), "utf8");
        return preferences.includes("Imported from settings") ? preferences : null;
      } catch {
        return null;
      }
    },
  );
  const profileEntries = await readdir(profileDir);
  const backup = profileEntries.find((entry) =>
    entry.startsWith("Default.ego-lite-backup-"),
  );
  if (!backup) throw new Error("import did not preserve the existing profile");
  try {
    await readFile(pendingImportFile, "utf8");
    throw new Error("pending import request was not consumed");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  secondConnection = await connectToRenderer();
  const toolbar = await waitFor("restarted Import data toolbar control", async () => {
    const value = await evaluate(
      secondConnection.connection,
      secondConnection.sessionId,
      "(() => ({hasImport: !!document.querySelector('#import-data'), status: document.querySelector('#status')?.textContent || ''}))()",
    );
    return value?.hasImport ? value : null;
  });
  if (!toolbar.hasImport) throw new Error("Import data control missing after restart");
  console.log(
    JSON.stringify({
      source: sourceUserData,
      imported: importedPreferences.includes("Imported from settings"),
      backup,
      pendingImportConsumed: true,
      toolbar,
      restartedBridgePort: restartedBridge.port,
    }),
  );
} catch (error) {
  const output = first ? `\nElectron output:\n${first.output()}` : "";
  throw new Error(`${error.message}${output}`);
} finally {
  await stopRelaunchedElectron();
  secondConnection?.connection.close();
  await stopElectron(first);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
