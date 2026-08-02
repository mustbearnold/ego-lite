import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const hostPath = resolve(testDir, "../../linux/ego-browser.mjs");
const sdkPath = resolve(repoDir, "package/ego-browser/dist/out/index.js");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-space-restore-"));
const statePath = join(profileDir, "task-spaces.json");
const spaceSessionPath = join(profileDir, "ego-lite-space-session.json");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
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
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
      EGO_BROWSER_SDK_PATH: sdkPath,
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

async function connectRenderer() {
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
  const renderer = await waitFor("Electron toolbar target", async () => {
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

async function runSdkProbe() {
  const child = spawn(process.execPath, [hostPath, "nodejs"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_BROWSER_SDK_PATH: sdkPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    "const task = await taskSpaces.useOrCreate(7); const tabs = await browser.listTabs(); console.log(JSON.stringify({taskId: task.id, tabs: tabs.map(({url, targetId}) => ({url, targetId}))}));\n",
  );
  const code = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  if (code !== 0) throw new Error(`SDK probe failed (${code})\n${stdout}\n${stderr}`);
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (!line) throw new Error(`SDK probe returned no JSON\n${stdout}\n${stderr}`);
  return JSON.parse(line);
}

try {
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      nextId: 8,
      spaces: [
        {
          taskId: "linux-space-7",
          id: 7,
          name: "persisted space",
          createdBy: "agent",
          ownership: "agent",
          createdAt: new Date().toISOString(),
          contextId: null,
          mode: "tab",
          tabTargetIds: [],
        },
      ],
    }, null, 2)}\n`,
  );

  first = startElectron();
  const firstBridge = await waitFor("first Electron bridge", readBridge);
  const firstTabs = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(firstBridge, "/tabs");
    return result.tabs?.some((tab) => tab.spaceId === null) ? result : null;
  });
  const one = await bridgeRequest(firstBridge, "/create-tab", {
    spaceId: 7,
    spaceName: "persisted space",
    url: "https://example.com/space-one",
  });
  const two = await bridgeRequest(firstBridge, "/create-tab", {
    spaceId: 7,
    spaceName: "persisted space",
    url: "https://example.com/space-two",
  });
  const saved = await waitFor("task-space session manifest", async () => {
    try {
      const manifest = JSON.parse(await readFile(spaceSessionPath, "utf8"));
      return manifest.spaces?.find((space) => space.id === 7)?.tabs?.length === 2
        ? manifest
        : null;
    } catch {
      return null;
    }
  });
  const firstSpaceTabs = saved.spaces.find((space) => space.id === 7).tabs;
  if (
    !firstSpaceTabs.some((tab) => tab.url.includes("space-one")) ||
    !firstSpaceTabs.some((tab) => tab.url.includes("space-two"))
  ) {
    throw new Error(`task-space tabs were not saved: ${JSON.stringify(saved)}`);
  }
  await stopElectron(first);

  second = startElectron();
  const secondBridge = await waitFor("second Electron bridge", async () => {
    try {
      const bridge = await readBridge();
      return bridge.token !== firstBridge.token ? bridge : null;
    } catch {
      return null;
    }
  });
  const restored = await waitFor("restored task-space tabs", async () => {
    const result = await bridgeRequest(secondBridge, "/tabs");
    const tabs = result.tabs?.filter((tab) => tab.spaceId === 7) || [];
    return tabs.length === 2 ? { ...result, tabs } : null;
  });
  if (
    !restored.tabs.some(
      (tab) => tab.url.includes("space-one") && !tab.active,
    ) ||
    !restored.tabs.some(
      (tab) => tab.url.includes("space-two") && !tab.active,
    )
  ) {
    throw new Error(`task-space restore changed visibility: ${JSON.stringify(restored)}`);
  }
  const sdk = await runSdkProbe();
  if (
    sdk.taskId !== 7 ||
    sdk.tabs.length !== 2 ||
    !sdk.tabs.every((tab) => tab.url.includes("example.com/space-"))
  ) {
    throw new Error(`SDK did not reuse restored task-space tabs: ${JSON.stringify(sdk)}`);
  }

  await bridgeRequest(secondBridge, "/activate-tab", {
    targetId: restored.tabs[0].targetId,
  });

  const renderer = await connectRenderer();
  try {
    const agentControl = await waitFor("agent control badge", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "document.querySelector('#control')?.textContent || ''",
      );
      return value === "Agent control" ? value : null;
    });
    const spaceMenu = await waitFor("Spaces menu", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "(() => { const menu = document.querySelector('#space-menu'); if (!menu || menu.hidden) return null; menu.open = true; return {open: menu.open, buttons: [...document.querySelectorAll('#space-list button')].map((button) => ({action: button.dataset.spaceAction, label: button.textContent}))}; })()",
      );
      return value?.open &&
        value.buttons?.some((button) => button.action === "ownership") &&
        value.buttons?.some((button) => button.action === "stop")
        ? value
        : null;
    });
    await evaluate(
      renderer.connection,
      renderer.sessionId,
      "document.querySelector('#space-list button[data-space-action=ownership]').click(); true",
    );
    const userControl = await waitFor("user control badge", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "document.querySelector('#control')?.textContent || ''",
      );
      return value === "User control" ? value : null;
    });
    const takenOverState = JSON.parse(await readFile(statePath, "utf8"));
    if (takenOverState.spaces.find((space) => space.id === 7)?.ownership !== "user") {
      throw new Error(`Space takeover did not persist: ${JSON.stringify(takenOverState)}`);
    }
    await evaluate(
      renderer.connection,
      renderer.sessionId,
      "document.querySelector('#space-list button[data-space-action=ownership]').click(); true",
    );
    const returnedAgentControl = await waitFor(
      "returned agent control badge",
      async () => {
        const value = await evaluate(
          renderer.connection,
          renderer.sessionId,
          "document.querySelector('#control')?.textContent || ''",
        );
        return value === "Agent control" ? value : null;
      },
    );
    const returnedState = JSON.parse(await readFile(statePath, "utf8"));
    if (returnedState.spaces.find((space) => space.id === 7)?.ownership !== "agent") {
      throw new Error(`Space return did not persist: ${JSON.stringify(returnedState)}`);
    }
    const toolbar = await waitFor("restored Space toolbar DOM", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "(() => ({options: [...document.querySelectorAll('#tab-picker option')].map((option) => option.textContent), selected: document.querySelector('#tab-picker option:checked')?.textContent || ''}))()",
      );
      return value?.options?.some((option) => option.includes("persisted space"))
        ? value
        : null;
    });
    await evaluate(
      renderer.connection,
      renderer.sessionId,
      "document.querySelector('#space-list button[data-space-action=stop]').click(); true",
    );
    const stopped = await waitFor("stopped Space", async () => {
      const result = await bridgeRequest(secondBridge, "/tabs");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      return !result.tabs?.some((tab) => tab.spaceId === 7) &&
        !state.spaces?.some((space) => space.id === 7)
        ? result
        : null;
    });
    const menuAfterStop = await waitFor("hidden Spaces menu", async () => {
      const value = await evaluate(
        renderer.connection,
        renderer.sessionId,
        "document.querySelector('#space-menu')?.hidden",
      );
      return value === true ? value : null;
    });
    console.log(
      JSON.stringify({
        createdTargetIds: [one.targetId, two.targetId],
        firstPrimaryActive: Boolean(firstTabs.tabs.find((tab) => tab.spaceId === null)?.active),
        restoredUrls: restored.tabs.map((tab) => tab.url).sort(),
        sdk,
        controls: {
          agentControl,
          spaceMenu,
          userControl,
          returnedAgentControl,
          stopped: !stopped.tabs.some((tab) => tab.spaceId === 7),
          menuAfterStop,
        },
        toolbar,
      }),
    );
  } finally {
    renderer.connection.close();
  }
} catch (error) {
  const output = [first, second]
    .map((instance, index) =>
      instance ? `Electron ${index + 1}:\n${instance.output()}` : "",
    )
    .filter(Boolean)
    .join("\n");
  throw new Error(`${error.message}\n${output}`);
} finally {
  await stopElectron(second);
  await stopElectron(first);
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
