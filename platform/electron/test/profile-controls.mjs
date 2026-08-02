import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(
  process.env.EGO_LITE_ELECTRON_EXECUTABLE ||
    resolve(testDir, "../node_modules/.bin/electron"),
);
const profileRoot = await mkdtemp(join(tmpdir(), "ego-electron-profiles-"));
const profileDir = join(profileRoot, "chromium-profile");
const registryPath = join(profileRoot, "profiles.json");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
let electron;
let relaunchedPid;

function profileDirectory(profileId) {
  return profileId === "default"
    ? profileDir
    : join(profileRoot, "profiles", profileId, "chromium-profile");
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

function startElectron(profileId = "default") {
  const child = spawn(electronPath, ["platform/electron"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_ROOT: profileRoot,
      EGO_LITE_PROFILE_ID: profileId,
      XDG_STATE_HOME: join(profileRoot, "state"),
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

async function readEndpoint(directory = profileDir) {
  try {
    const lines = (
      await readFile(join(directory, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
}

async function stopProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await waitFor(
    `profile process ${pid} shutdown`,
    async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    5_000,
  ).catch(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The relaunched profile process already exited.
    }
  });
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

try {
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: [
          { id: "default", name: "Personal" },
          { id: "work", name: "Work" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  electron = startElectron();
  const defaultBridge = await waitFor("Electron bridge", async () => {
    try {
      return JSON.parse(await readFile(bridgeFile, "utf8"));
    } catch {
      return null;
    }
  });
  const endpoint = await waitFor("Electron CDP", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    const toolbar = await waitFor("toolbar target", async () => {
      const targets = await connection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const attached = await connection.request("Target.attachToTarget", {
      targetId: toolbar.targetId,
      flatten: true,
    });
    const profiles = await waitFor("profile toolbar menu", async () => {
      const value = await evaluate(
        connection,
        attached.sessionId,
        "(() => ({visible: !document.querySelector('#profile-menu').hidden, summary: document.querySelector('#profile-menu summary')?.textContent, buttons: [...document.querySelectorAll('#profile-list button')].map((button) => ({id: button.dataset.profileId || null, label: button.textContent, disabled: button.disabled}))}))()",
      );
      return value?.visible && value.buttons?.length === 3 ? value : null;
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    await evaluate(
      connection,
      attached.sessionId,
      "window.egoLite.switchProfile({id: 'work'}); true",
    );
    console.log(
      JSON.stringify({ profiles, registry, defaultPid: defaultBridge.pid }),
    );
  } finally {
    connection.close();
  }
  await stopElectron(electron);
  const workProfileDir = profileDirectory("work");
  const workBridge = await waitFor("relaunch into Work profile", async () => {
    try {
      const value = JSON.parse(
        await readFile(join(workProfileDir, "ego-lite-bridge.json"), "utf8"),
      );
      return Number.isInteger(value.pid) ? value : null;
    } catch {
      return null;
    }
  });
  relaunchedPid = workBridge.pid;
  const workEndpoint = await waitFor("Work profile CDP", () =>
    readEndpoint(workProfileDir),
  );
  const workConnection = await new CdpConnection(workEndpoint).connect();
  try {
    const toolbar = await waitFor("Work toolbar target", async () => {
      const targets = await workConnection.request("Target.getTargets");
      return targets.targetInfos?.find((target) =>
        target.url.includes("/renderer/index.html"),
      );
    });
    const attached = await workConnection.request("Target.attachToTarget", {
      targetId: toolbar.targetId,
      flatten: true,
    });
    const summary = await waitFor("Work profile label", async () => {
      const value = await evaluate(
        workConnection,
        attached.sessionId,
        "document.querySelector('#profile-menu summary')?.textContent",
      );
      return value === "Profile · Work" ? value : null;
    });
    console.log(
      JSON.stringify({ restartedProfile: summary, workPid: relaunchedPid }),
    );
  } finally {
    workConnection.close();
  }
} catch (error) {
  throw new Error(
    `${error.message}\nElectron output:\n${electron?.output() || ""}`,
  );
} finally {
  await stopElectron(electron);
  await stopProcess(relaunchedPid);
  await rm(profileRoot, { recursive: true, force: true });
}
