import assert from "node:assert/strict";
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
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-last-tab-"));
const statePath = join(profileDir, "task-spaces.json");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
let electron;

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

function startElectron() {
  const child = spawn(electronPath, electronArguments, {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
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

try {
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        nextId: 8,
        spaces: [
          {
            taskId: "last-tab-space",
            id: 7,
            name: "last tab parity",
            createdBy: "agent",
            ownership: "agent",
            createdAt: new Date().toISOString(),
            contextId: null,
            mode: "tab",
            tabTargetIds: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  electron = startElectron();
  const bridge = await waitFor("Electron bridge", readBridge);
  const initial = await waitFor("primary tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null) || null;
  });

  const task = await bridgeRequest(bridge, "/create-tab", {
    spaceId: 7,
    spaceName: "last tab parity",
    url: "about:blank",
  });
  await bridgeRequest(bridge, "/close-tab", { targetId: task.targetId });
  const afterSpaceClose = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(
    afterSpaceClose.spaces.some((space) => space.id === 7),
    false,
  );

  const closeResult = await bridgeRequest(bridge, "/close-tab", {
    targetId: initial.targetId,
  });
  assert.equal(closeResult.windowClosed, true);
  await waitFor(
    "native window close after last primary tab",
    async () =>
      electron.child.exitCode !== null || electron.child.signalCode !== null,
  );
  console.log(
    JSON.stringify({
      spaceRemoved: true,
      windowClosed: true,
      executable: packagedExecutable ? "packaged" : "source",
    }),
  );
} catch (error) {
  throw new Error(`${error.message}\nElectron output:\n${electron?.output() || ""}`);
} finally {
  if (electron?.child && electron.child.exitCode === null) {
    electron.child.kill("SIGTERM");
  }
  await rm(profileDir, { recursive: true, force: true });
}
