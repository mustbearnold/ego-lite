import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArguments = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-external-routing-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const statePath = join(profileDir, "task-spaces.json");
const initialFile = join(profileDir, "initial.html");
const secondFile = join(profileDir, "second.html");
const thirdFile = join(profileDir, "third.html");
let first;
let second;
let server;

await writeFile(initialFile, "<!doctype html><title>Initial external file</title>");
await writeFile(secondFile, "<!doctype html><title>Second external file</title>");
await writeFile(thirdFile, "<!doctype html><title>Third external file</title>");

server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>HTTP external target</title>");
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("HTTP external target server did not receive a port");
}
const httpTarget = `http://127.0.0.1:${address.port}/external`;

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
  if (!response.ok) throw new Error(payload.error || `bridge failed: ${pathname}`);
  return payload;
}

function startElectron(targets) {
  const child = spawn(
    electronPath,
    [...electronArguments, "--launch", ...targets],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        EGO_LITE_PROFILE_DIR: profileDir,
        EGO_LITE_STATE_PATH: statePath,
        EGO_LITE_DISABLE_GPU: "1",
        EGO_LITE_SKIP_MIGRATION: "1",
        EGO_LITE_DISABLE_WELCOME: "1",
        EGO_LITE_DISABLE_AUTO_UPDATE: "1",
        ELECTRON_DISABLE_SANDBOX: "1",
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        WAYLAND_DISPLAY: "",
        XDG_SESSION_TYPE: "x11",
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

try {
  first = startElectron([
    pathToFileURL(initialFile).toString(),
    secondFile,
  ]);
  const bridge = await waitFor("Electron bridge", readBridge);
  const expectedInitial = pathToFileURL(initialFile).toString();
  const expectedSecond = pathToFileURL(secondFile).toString();
  const initial = await waitFor("initial external tabs", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    const primary = result.tabs?.filter((tab) => tab.spaceId === null) || [];
    return primary.length === 2 &&
      primary.some((tab) => tab.url === expectedInitial) &&
      primary.some((tab) => tab.url === expectedSecond)
      ? result
      : null;
  });
  const initialPrimary = initial.tabs.filter((tab) => tab.spaceId === null);
  assert.equal(initialPrimary.length, 2);
  assert.equal(
    initialPrimary.find((tab) => tab.url === expectedSecond)?.active,
    true,
  );

  second = startElectron([httpTarget, pathToFileURL(thirdFile).toString()]);
  await waitFor(
    "second instance exit",
    async () =>
      second.child.exitCode !== null || second.child.signalCode !== null,
    5_000,
  );

  const expectedThird = pathToFileURL(thirdFile).toString();
  const routed = await waitFor("second-instance external tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    const primary = result.tabs?.filter((tab) => tab.spaceId === null) || [];
    const third = primary.find((tab) => tab.url === expectedThird);
    const http = primary.find((tab) => tab.url === httpTarget);
    return primary.length === 4 && third?.active && http ? result : null;
  });
  const primary = routed.tabs.filter((tab) => tab.spaceId === null);
  assert.equal(primary.length, 4);
  assert.deepEqual(
    new Set(primary.map((tab) => tab.url)),
    new Set([expectedInitial, expectedSecond, expectedThird, httpTarget]),
  );
  console.log(
    JSON.stringify({
      initialTargetsOpened: 2,
      secondInstanceTargetsOpened: 2,
      localFilePathArgumentConverted: true,
      httpTargetOpened: true,
      activeExternalTarget: expectedThird,
      executable: packagedExecutable ? "packaged" : "source",
    }),
  );
} catch (error) {
  throw new Error(
    `${error.message}\nFirst Electron output:\n${first?.output() || ""}\nSecond Electron output:\n${second?.output() || ""}`,
  );
} finally {
  await stopElectron(second);
  await stopElectron(first);
  if (server?.listening) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  await rm(profileDir, { recursive: true, force: true });
}
