import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArgs = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-background-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const environment = {
  ...process.env,
  EGO_LITE_PROFILE_DIR: profileDir,
  EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
  EGO_LITE_DISABLE_GPU: "1",
};

const child = spawn(electronPath, electronArgs, {
  cwd: repoDir,
  env: environment,
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(label, callback, timeoutMs = 15000) {
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

async function bridgeRequest(bridge, path, body = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ego-lite-token": bridge.token,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `bridge request failed: ${path}`);
  }
  return payload;
}

async function tabsWith(bridge) {
  return bridgeRequest(bridge, "/tabs");
}

try {
  const bridge = await waitFor("Electron bridge", readBridge);
  const initial = await waitFor("primary browser tab", async () => {
    const result = await tabsWith(bridge);
    return result.tabs?.some((tab) => tab.spaceId === null) ? result : null;
  });
  const primary = initial.tabs.find((tab) => tab.spaceId === null);
  if (!primary?.active) {
    throw new Error(
      `primary tab is not visible initially: ${JSON.stringify(initial)}`,
    );
  }

  const created = await bridgeRequest(bridge, "/create-tab", {
    spaceId: 1,
    spaceName: "background parity",
    url: "about:blank",
  });
  const background = await waitFor("background task tab", async () => {
    const result = await tabsWith(bridge);
    const task = result.tabs?.find((tab) => tab.targetId === created.targetId);
    return task && result.tabs.find((tab) => tab.targetId === primary.targetId)
      ? result
      : null;
  });
  const backgroundTask = background.tabs.find(
    (tab) => tab.targetId === created.targetId,
  );
  const backgroundPrimary = background.tabs.find(
    (tab) => tab.targetId === primary.targetId,
  );
  if (backgroundTask.active || !backgroundPrimary.active) {
    throw new Error(
      `creating a task tab changed the visible tab: ${JSON.stringify(background)}`,
    );
  }
  if (backgroundTask.spaceName !== "background parity") {
    throw new Error(
      `task tab did not retain its Space label: ${JSON.stringify(backgroundTask)}`,
    );
  }

  await bridgeRequest(bridge, "/activate-tab", { targetId: created.targetId });
  const revealed = await waitFor("explicit task reveal", async () => {
    const result = await tabsWith(bridge);
    const task = result.tabs?.find((tab) => tab.targetId === created.targetId);
    const visiblePrimary = result.tabs?.find(
      (tab) => tab.targetId === primary.targetId,
    );
    return task?.active && visiblePrimary ? result : null;
  });
  if (revealed.tabs.find((tab) => tab.targetId === primary.targetId).active) {
    throw new Error(
      `explicit task reveal left the primary visible: ${JSON.stringify(revealed)}`,
    );
  }

  await bridgeRequest(bridge, "/close-tab", { targetId: created.targetId });
  const restored = await waitFor("primary tab restore", async () => {
    const result = await tabsWith(bridge);
    return result.tabs?.find((tab) => tab.targetId === primary.targetId)?.active
      ? result
      : null;
  });
  console.log(
    JSON.stringify({
      primaryTargetId: primary.targetId,
      backgroundTargetId: created.targetId,
      backgroundSpaceName: backgroundTask.spaceName,
      backgroundActive: backgroundTask.active,
      restoredPrimaryActive: Boolean(
        restored.tabs.find((tab) => tab.targetId === primary.targetId)?.active,
      ),
    }),
  );
} catch (error) {
  throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
} finally {
  if (!child.killed) child.kill("SIGTERM");
  await waitFor(
    "Electron shutdown",
    async () => child.exitCode !== null || child.signalCode !== null,
    3000,
  ).catch(() => {
    child.kill("SIGKILL");
  });
  await rm(profileDir, { recursive: true, force: true });
}
