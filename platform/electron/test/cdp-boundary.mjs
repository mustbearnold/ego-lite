import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoDir = resolve(import.meta.dirname, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(import.meta.dirname, "../node_modules/.bin/electron");
const electronArgs = packagedExecutable
  ? ["--cli", "nodejs"]
  : ["platform/electron", "--cli", "nodejs"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-cdp-boundary-"));
const statePath = join(profileDir, "task-spaces.json");
const sdkPath = resolve(repoDir, "package/ego-browser/dist/out/index.js");

const environment = {
  ...process.env,
  EGO_LITE_PROFILE_DIR: profileDir,
  EGO_LITE_STATE_PATH: statePath,
  EGO_LITE_SKIP_MIGRATION: "1",
  EGO_LITE_DISABLE_AUTO_UPDATE: "1",
  EGO_LITE_DISABLE_GPU: "1",
  ...(packagedExecutable ? {} : { EGO_BROWSER_SDK_PATH: sdkPath }),
  ELECTRON_DISABLE_SANDBOX: "1",
  ELECTRON_OZONE_PLATFORM_HINT: "x11",
  WAYLAND_DISPLAY: "",
  XDG_SESSION_TYPE: "x11",
};

function runElectron(source) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(electronPath, electronArgs, {
      cwd: repoDir,
      env: environment,
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
      if (code !== 0) {
        rejectPromise(
          new Error(
            `CLI exited with ${code ?? "no code"} (${signal || "no signal"})\n${stdout}\n${stderr}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(source);
  });
}

try {
  const { stdout, stderr } = await runElectron(`
    const task = await taskSpaces.useOrCreate("cdp boundary");
    const methods = [
      ["Target.createTarget", { url: "about:blank" }],
      ["Target.createBrowserContext", {}],
      ["Target.disposeBrowserContext", { browserContextId: "not-managed" }],
    ];
    const blocked = [];
    for (const [method, params] of methods) {
      try {
        await cdp(method, params);
      } catch (error) {
        blocked.push({
          method,
          code: error.error_code || null,
          message: error.message,
        });
      }
    }
    await taskSpaces.complete(task.id, { keep: false });
    console.log("EGO_CDP_BOUNDARY_RESULT:" + JSON.stringify({
      taskId: task.id,
      blocked,
    }));
  `);
  const marker = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("EGO_CDP_BOUNDARY_RESULT:"));
  assert.ok(marker, `boundary marker missing\n${stdout}\n${stderr}`);
  const result = JSON.parse(marker.slice("EGO_CDP_BOUNDARY_RESULT:".length));
  assert.equal(result.blocked.length, 3);
  for (const entry of result.blocked) {
    assert.equal(entry.code, "EGO_CDP_SEND_FAILED");
    assert.match(entry.message, new RegExp(entry.method.replaceAll(".", "\\.")));
  }
  console.log(
    JSON.stringify({
      blockedMethods: result.blocked.map((entry) => entry.method),
      executable: packagedExecutable ? "packaged" : "source",
    }),
  );
} finally {
  await rm(profileDir, { recursive: true, force: true });
}
