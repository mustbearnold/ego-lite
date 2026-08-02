import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoDir = resolve(import.meta.dirname, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable ||
  resolve(import.meta.dirname, "../node_modules/.bin/electron");
const electronArgs = packagedExecutable
  ? ["--cli", "nodejs"]
  : ["platform/electron", "--cli", "nodejs"];
const sdkPath = resolve(repoDir, "package/ego-browser/dist/out/index.js");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-cookie-parity-"));
const statePath = join(profileDir, "task-spaces.json");
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>cookie parity fixture</title>");
});

await new Promise((resolvePromise, rejectPromise) => {
  fixtureServer.once("error", rejectPromise);
  fixtureServer.listen(0, "127.0.0.1", resolvePromise);
});

const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
const environment = {
  ...process.env,
  EGO_LITE_PROFILE_DIR: profileDir,
  EGO_LITE_STATE_PATH: statePath,
  EGO_LITE_DISABLE_GPU: "1",
  ...(packagedExecutable ? {} : { EGO_BROWSER_SDK_PATH: sdkPath }),
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
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(
          `Electron exited with ${code ?? "no code"} (${signal || "no signal"})\n${stdout}\n${stderr}`,
        ),
      );
    });
    child.stdin.end(source);
  });
}

try {
  const { stdout, stderr } = await runElectron(`
    const fixtureUrl = ${JSON.stringify(fixtureUrl)};
    await cdp("Network.setCookie", {
      url: fixtureUrl,
      name: "ego_primary",
      value: "seeded",
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
    });
    await page.goto(fixtureUrl);
    const primaryCookie = await page.evaluate(() => document.cookie);

    const task = await taskSpaces.useOrCreate("cookie parity");
    await page.goto(fixtureUrl);
    const inheritedCookie = await page.evaluate(() => document.cookie);
    await cdp("Network.setCookie", {
      url: fixtureUrl,
      name: "ego_task_only",
      value: "isolated",
    });
    await page.reload();
    const taskCookie = await page.evaluate(() => document.cookie);
    await taskSpaces.complete(task.id, { keep: false });

    const primaryCookies = await cdp("Network.getAllCookies");
    console.log("EGO_COOKIE_PARITY_RESULT:" + JSON.stringify({
      primaryCookie,
      inheritedCookie,
      taskCookie,
      primaryAfterTask: primaryCookies.cookies
        .filter((cookie) => cookie.name.startsWith("ego_"))
        .map((cookie) => cookie.name + "=" + cookie.value)
        .sort(),
    }));
  `);

  const marker = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("EGO_COOKIE_PARITY_RESULT:"));
  if (!marker) {
    throw new Error(`cookie parity marker missing\n${stdout}\n${stderr}`);
  }
  const result = JSON.parse(marker.slice("EGO_COOKIE_PARITY_RESULT:".length));
  if (result.primaryCookie !== "ego_primary=seeded") {
    throw new Error(`primary cookie was not set: ${JSON.stringify(result)}`);
  }
  if (result.inheritedCookie !== "ego_primary=seeded") {
    throw new Error(
      `task space did not inherit the primary cookie: ${JSON.stringify(result)}`,
    );
  }
  if (
    result.taskCookie !== "ego_primary=seeded; ego_task_only=isolated" &&
    result.taskCookie !== "ego_task_only=isolated; ego_primary=seeded"
  ) {
    throw new Error(
      `task cookie isolation probe failed: ${JSON.stringify(result)}`,
    );
  }
  if (JSON.stringify(result.primaryAfterTask) !== '["ego_primary=seeded"]') {
    throw new Error(
      `task cookie leaked into primary session: ${JSON.stringify(result)}`,
    );
  }
  console.log(JSON.stringify(result));
} finally {
  fixtureServer.close();
  await rm(profileDir, { recursive: true, force: true });
}
