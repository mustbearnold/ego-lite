import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = join(repoDir, "platform/linux/ego-browser.mjs");
const electronPath = join(repoDir, "platform/electron/node_modules/.bin/electron");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const root = await mkdtemp(join(tmpdir(), "ego-migrated-tabs-"));
const sourceUserData = join(root, "source-browser");
const sourceProfile = join(sourceUserData, "Default");
const sourceExtension = join(root, "source-extension");
const targetUserData = join(root, "ego-profile");
const bridgeFile = join(targetUserData, "ego-lite-bridge.json");

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

async function readEndpoint(userDataDir) {
  try {
    const lines = (
      await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
}

async function startChromium(userDataDir, { extensionDir, restore } = {}) {
  await mkdir(userDataDir, { recursive: true });
  const args = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--noerrdialogs",
    "--no-sandbox",
  ];
  if (extensionDir) {
    args.push(
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    );
  } else {
    args.push("--disable-extensions");
  }
  if (restore) args.push("--restore-last-session");
  const child = spawn(executable, args, { stdio: "ignore" });
  const connection = await waitFor("Chromium CDP", async () => {
    const endpoint = await readEndpoint(userDataDir);
    if (!endpoint) return null;
    const candidate = new CdpConnection(endpoint);
    try {
      return await candidate.connect();
    } catch {
      candidate.close();
      return null;
    }
  });
  return { child, connection };
}

async function stopChromium(browser) {
  await Promise.race([
    browser.connection.request("Browser.close").catch(() => {}),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  browser.connection.close();
  await waitFor(
    "Chromium shutdown",
    async () => browser.child.exitCode !== null || browser.child.signalCode !== null,
    5_000,
  ).catch(() => browser.child.kill("SIGKILL"));
}

async function attachServiceWorker(connection) {
  return waitFor("migration fixture extension", async () => {
    const targets = await connection.request("Target.getTargets");
    const worker = targets.targetInfos?.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://"),
    );
    if (!worker) return null;
    const result = await connection.request("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    });
    await connection.request("Runtime.enable", {}, result.sessionId).catch(() => {});
    return result.sessionId;
  });
}

async function evaluate(connection, sessionId, expression) {
  const result = await Promise.race([
    connection.request(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    ),
    new Promise((_, rejectPromise) =>
      setTimeout(
        () => rejectPromise(new Error("fixture evaluation timed out")),
        5_000,
      ),
    ),
  ]);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text || "Runtime.evaluate failed",
    );
  }
  return result.result?.value;
}

async function runMigration() {
  const child = spawn(
    process.execPath,
    [hostPath, "--migrate-profile", "--from", sourceUserData],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        EGO_LITE_PROFILE_DIR: targetUserData,
        EGO_BROWSER_EXECUTABLE: executable,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  if (code !== 0) throw new Error(`migration failed (${code})\n${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}

async function runHostDoctor(statePath) {
  const child = spawn(process.execPath, [hostPath, "--doctor"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: targetUserData,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_HEADLESS: "1",
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
  let report;
  try {
    report = await waitFor(
      "standalone host doctor output",
      async () => {
        try {
          return JSON.parse(stdout);
        } catch {
          return null;
        }
      },
      20_000,
    );
  } catch (error) {
    throw new Error(
      `${error.message}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(`doctor failed (${child.exitCode})\n${stdout}\n${stderr}`);
  }
  if (!child.killed) child.kill("SIGTERM");
  await sleep(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return report;
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

async function startElectron() {
  const child = spawn(electronPath, ["platform/electron"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: targetUserData,
      EGO_LITE_STATE_PATH: join(root, "state", "task-spaces.json"),
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
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
  return { child, getOutput: () => `${stdout}\n${stderr}` };
}

try {
  await mkdir(sourceExtension, { recursive: true });
  await writeFile(
    join(sourceExtension, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "migration tab fixture",
        version: "1.0.0",
        permissions: ["tabs", "tabGroups"],
        background: { service_worker: "service-worker.js" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(sourceExtension, "service-worker.js"),
    "chrome.runtime.onInstalled.addListener(() => {});\n",
  );
  await mkdir(sourceProfile, { recursive: true });
  await writeFile(join(sourceProfile, "Bookmarks"), '{"roots":{}}\n');

  const sourceBrowser = await startChromium(sourceUserData, {
    extensionDir: sourceExtension,
  });
  try {
    const first = await sourceBrowser.connection.request("Target.createTarget", {
      url: "https://example.com/migrated-one",
    });
    const second = await sourceBrowser.connection.request("Target.createTarget", {
      url: "https://example.com/migrated-two",
    });
    const workerSession = await attachServiceWorker(sourceBrowser.connection);
    const sourceTabs = await waitFor("source fixture tabs", async () => {
      const tabs = await evaluate(
        sourceBrowser.connection,
        workerSession,
        "new Promise((resolve) => chrome.tabs.query({}, resolve))",
      );
      const selected = tabs.filter((tab) =>
        tab.url.includes("example.com/migrated-"),
      );
      return selected.length === 2 ? selected : null;
    });
    const groupId = await evaluate(
      sourceBrowser.connection,
      workerSession,
      `chrome.tabs.group({tabIds: [${sourceTabs.map((tab) => tab.id).join(",")}]})`,
    );
    await evaluate(
      sourceBrowser.connection,
      workerSession,
      `chrome.tabGroups.update(${groupId}, {title: "Migration fixture", color: "blue", collapsed: true})`,
    );
  } finally {
    await stopChromium(sourceBrowser);
  }

  const report = await runMigration();
  const manifestPath = join(targetUserData, "ego-lite-migrated-tabs.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (report.tabs?.found !== 2 || manifest.tabs.length !== 2) {
    throw new Error(`migrated tab count mismatch: ${JSON.stringify({ report, manifest })}`);
  }
  if (
    manifest.groups.length !== 1 ||
    manifest.groups[0].title !== "Migration fixture" ||
    manifest.groups[0].color !== "blue" ||
    !manifest.groups[0].collapsed
  ) {
    throw new Error(`migrated tab group mismatch: ${JSON.stringify(manifest)}`);
  }

  const manifestText = await readFile(manifestPath, "utf8");
  const doctor = await runHostDoctor(join(root, "state", "task-spaces.json"));
  if (
    doctor.tabs?.filter((tab) => tab.url.includes("example.com/migrated-")).length !== 2
  ) {
    throw new Error(`standalone host did not restore migrated tabs: ${JSON.stringify(doctor)}`);
  }
  const standaloneConnection = await waitFor(
    "standalone host CDP",
    async () => {
      const endpoint = await readEndpoint(targetUserData);
      if (!endpoint) return null;
      const candidate = new CdpConnection(endpoint);
      try {
        return await candidate.connect();
      } catch {
        candidate.close();
        return null;
      }
    },
  );
  await standaloneConnection.request("Browser.close").catch(() => {});
  standaloneConnection.close();
  await sleep(1_000);
  await writeFile(manifestPath, manifestText);

  const electron = await startElectron();
  try {
    const bridge = await waitFor("Electron bridge", async () => {
      try {
        return JSON.parse(await readFile(bridgeFile, "utf8"));
      } catch {
        return null;
      }
    });
    const restored = await waitFor("restored Electron tabs", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      return result.tabs?.filter((tab) =>
        tab.url.includes("example.com/migrated-"),
      ).length === 2
        ? result
        : null;
    });
    const restoredTabs = restored.tabs.filter((tab) =>
      tab.url.includes("example.com/migrated-"),
    );
    if (
      restoredTabs.some(
        (tab) =>
          tab.tabGroup?.title !== "Migration fixture" ||
          tab.tabGroup?.color !== "blue" ||
          !tab.tabGroup?.collapsed,
      )
    ) {
      throw new Error(`Electron tab groups were not restored: ${JSON.stringify(restored)}`);
    }

    const connection = await waitFor("Electron renderer CDP", async () => {
      const endpoint = await readEndpoint(targetUserData);
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
      const renderer = await waitFor("Electron toolbar DOM", async () => {
        const targets = await connection.request("Target.getTargets");
        return targets.targetInfos?.find((target) =>
          target.url.includes("/renderer/index.html"),
        );
      });
      const attached = await connection.request("Target.attachToTarget", {
        targetId: renderer.targetId,
        flatten: true,
      });
      const dom = await waitFor("grouped toolbar options", async () => {
        const value = await evaluate(
          connection,
          attached.sessionId,
          `(() => ({
            groupCount: document.querySelectorAll("#tab-picker optgroup").length,
            labels: [...document.querySelectorAll("#tab-picker optgroup")].map((node) => node.label),
            optionCount: document.querySelectorAll("#tab-picker option").length,
          }))()`,
        );
        return value?.groupCount === 1 && value.optionCount >= 2 ? value : null;
      });
      if (
        !dom.labels[0].includes("Migration fixture") ||
        !dom.labels[0].includes("blue") ||
        !dom.labels[0].includes("collapsed")
      ) {
        throw new Error(`group label mismatch: ${JSON.stringify(dom)}`);
      }
      console.log(
        JSON.stringify({
          reportTabs: report.tabs,
          restoredUrls: restoredTabs.map((tab) => tab.url).sort(),
          toolbar: dom,
        }),
      );
    } finally {
      connection.close();
    }
  } catch (error) {
    throw new Error(`${error.message}\nElectron output:\n${electron.getOutput()}`);
  } finally {
    if (!electron.child.killed) electron.child.kill("SIGTERM");
    await waitFor(
      "Electron shutdown",
      async () =>
        electron.child.exitCode !== null || electron.child.signalCode !== null,
      5_000,
    ).catch(() => electron.child.kill("SIGKILL"));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
