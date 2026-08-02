import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath = resolve(
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron"),
);
const serverName = "ci-blue";
const electronArguments = packagedExecutable
  ? ["--cli", "--server-name", serverName, "--doctor"]
  : [
      "platform/electron",
      "--cli",
      "--server-name",
      serverName,
      "--doctor",
    ];
const profileRoot = await mkdtemp(join(tmpdir(), "ego-electron-server-name-"));
const stateHome = join(profileRoot, "state");

function parseReport(stdout) {
  const starts = [];
  for (const match of stdout.matchAll(/^\s*\{/gm)) starts.push(match.index);
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      // Electron diagnostics can follow the JSON report.
    }
  }
  throw new Error(`CLI did not emit a JSON report:\n${stdout}`);
}

function runCli() {
  const environment = {
    ...process.env,
    EGO_LITE_PROFILE_ROOT: profileRoot,
    XDG_STATE_HOME: stateHome,
    EGO_LITE_DISABLE_GPU: "1",
    EGO_LITE_SKIP_MIGRATION: "1",
    EGO_LITE_DISABLE_AUTO_UPDATE: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    WAYLAND_DISPLAY: "",
    XDG_SESSION_TYPE: "x11",
  };
  const child = spawn(electronPath, electronArguments, {
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

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

try {
  const result = await runCli();
  assert.equal(
    result.code,
    0,
    `named CLI failed (${result.signal || "no signal"})\n${result.stdout}\n${result.stderr}`,
  );
  const report = parseReport(result.stdout);
  assert.equal(report.serverName, serverName);
  assert.equal(
    report.profileDir,
    join(profileRoot, "servers", serverName, "chromium-profile"),
  );
  assert.equal(
    report.statePath,
    join(
      stateHome,
      "ego-lite",
      "servers",
      serverName,
      "task-spaces.json",
    ),
  );
  console.log(
    JSON.stringify({
      serverName: report.serverName,
      profileDir: report.profileDir,
      statePath: report.statePath,
      executable: packagedExecutable ? "packaged" : "source",
    }),
  );
} finally {
  await rm(profileRoot, { recursive: true, force: true });
}
