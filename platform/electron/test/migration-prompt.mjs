import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const root = await mkdtemp(join(tmpdir(), "ego-electron-migration-prompt-"));
const profileDir = join(root, "chromium-profile");
const sourceProfile = join(root, "config", "google-chrome", "Default");
const selectedProfile = join(root, "config", "google-chrome", "Profile 1");
const markerPath = join(profileDir, ".migration-prompted");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const multiProfile = process.env.EGO_LITE_TEST_MULTI_PROFILE === "1";
const expectedSource = multiProfile ? selectedProfile : sourceProfile;
const environment = {
  ...process.env,
  EGO_LITE_PROFILE_ROOT: root,
  EGO_LITE_STATE_PATH: join(root, "state", "task-spaces.json"),
  EGO_LITE_DISABLE_GPU: "1",
  EGO_LITE_MIGRATION_PROMPT: "1",
  EGO_LITE_MIGRATION_CHOICE:
    process.env.EGO_LITE_TEST_MIGRATION_CHOICE || "skip",
  EGO_LITE_MIGRATION_SOURCE: multiProfile ? selectedProfile : "",
  XDG_CONFIG_HOME: join(root, "config"),
};

const child = spawn(electronPath, ["platform/electron"], {
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

try {
  await mkdir(sourceProfile, { recursive: true });
  await writeFile(join(sourceProfile, "Preferences"), '{"profile":{}}\n');
  if (multiProfile) {
    await mkdir(selectedProfile, { recursive: true });
    await writeFile(
      join(selectedProfile, "Preferences"),
      '{"profile":{"name":"selected profile"}}\n',
    );
  }
  await waitFor("Electron bridge after migration decision", async () => {
    try {
      return JSON.parse(await readFile(bridgeFile, "utf8"));
    } catch {
      return null;
    }
  });
  const marker = await readFile(markerPath, "utf8");
  if (!marker.includes(`source=${expectedSource}`)) {
    throw new Error(`migration marker did not record source: ${marker}`);
  }
  const decision = environment.EGO_LITE_MIGRATION_CHOICE;
  if (decision === "migrate") {
    const migratedPreferences = await readFile(
      join(profileDir, "Default", "Preferences"),
      "utf8",
    );
    if (!migratedPreferences.includes('"profile"')) {
      throw new Error(
        `migration did not copy source Preferences: ${migratedPreferences}`,
      );
    }
    if (multiProfile && !migratedPreferences.includes("selected profile")) {
      throw new Error(
        `migration did not use the selected profile: ${migratedPreferences}`,
      );
    }
  }
  console.log(JSON.stringify({ decision, markerSource: expectedSource, multiProfile }));
} catch (error) {
  throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
} finally {
  if (!child.killed) child.kill("SIGTERM");
  await waitFor(
    "Electron shutdown",
    async () => child.exitCode !== null || child.signalCode !== null,
    3000,
  ).catch(() => child.kill("SIGKILL"));
  await rm(root, { recursive: true, force: true });
}
