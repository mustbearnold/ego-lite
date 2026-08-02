import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(
  process.env.EGO_LITE_ELECTRON_EXECUTABLE ||
    resolve(testDir, "../node_modules/.bin/electron"),
);
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-window-state-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const windowStatePath = join(profileDir, "ego-lite-window.json");
const seededState = {
  version: 1,
  x: 100,
  y: 40,
  width: 960,
  height: 620,
  maximized: false,
};
let electron;
const execFileAsync = promisify(execFile);

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
      EGO_LITE_WINDOW_STATE_PATH: windowStatePath,
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
      EGO_LITE_DISABLE_AUTO_UPDATE: "1",
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

async function readWindowBounds() {
  const { stdout: windows } = await execFileAsync("xdotool", [
    "search",
    "--onlyvisible",
    "--name",
    "^ego lite$",
  ]);
  const windowId = windows.trim().split(/\s+/).filter(Boolean)[0];
  if (!windowId) return null;
  const { stdout: geometry } = await execFileAsync("xdotool", [
    "getwindowgeometry",
    "--shell",
    windowId,
  ]);
  const values = Object.fromEntries(
    geometry
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("="))
      .filter(([key, value]) => key && value),
  );
  return {
    windowId,
    bounds: {
      x: Number(values.X),
      y: Number(values.Y),
      width: Number(values.WIDTH),
      height: Number(values.HEIGHT),
    },
  };
}

try {
  await writeFile(windowStatePath, `${JSON.stringify(seededState, null, 2)}\n`);
  electron = startElectron();
  await waitFor("Electron bridge", readBridge);
  const seededBounds = await waitFor(
    "seeded Electron bounds",
    readWindowBounds,
  );
  if (
    seededBounds.bounds.width !== seededState.width ||
    seededBounds.bounds.height !== seededState.height
  ) {
    throw new Error(
      `seeded bounds were not restored: ${JSON.stringify(seededBounds)}`,
    );
  }

  const windowInfo = await waitFor("Electron window bounds", readWindowBounds);
  await execFileAsync("xdotool", [
    "windowmove",
    windowInfo.windowId,
    "120",
    "60",
  ]);
  await execFileAsync("xdotool", [
    "windowsize",
    windowInfo.windowId,
    "1000",
    "650",
  ]);
  const updatedBounds = await waitFor("updated Electron bounds", async () => {
    const result = await readWindowBounds();
    return result?.bounds.width === 1000 && result.bounds.height === 650
      ? result
      : null;
  });
  await stopElectron(electron);

  const persisted = JSON.parse(await readFile(windowStatePath, "utf8"));
  for (const [key, expected] of Object.entries({
    version: 1,
    width: 1000,
    height: 650,
    maximized: false,
  })) {
    if (persisted[key] !== expected) {
      throw new Error(
        `window state ${key} was ${JSON.stringify(persisted[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  await rm(bridgeFile, { force: true });
  electron = startElectron();
  await waitFor("Electron bridge after restart", readBridge);
  const restoredBounds = await waitFor(
    "restored Electron bounds",
    readWindowBounds,
  );
  if (
    restoredBounds.bounds.width !== persisted.width ||
    restoredBounds.bounds.height !== persisted.height
  ) {
    throw new Error(
      `saved bounds were not restored: ${JSON.stringify(restoredBounds)}`,
    );
  }

  console.log(
    JSON.stringify({
      seeded: seededBounds.bounds,
      updated: updatedBounds.bounds,
      persisted,
      restored: restoredBounds.bounds,
    }),
  );
} catch (error) {
  throw new Error(
    `${error.message}\nElectron output:\n${electron?.output() || ""}`,
  );
} finally {
  await stopElectron(electron);
  await rm(profileDir, { recursive: true, force: true });
}
