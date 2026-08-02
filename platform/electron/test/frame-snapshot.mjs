import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = join(repoDir, "platform/linux/ego-browser.mjs");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath =
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron");
const electronArgs = packagedExecutable ? [] : ["platform/electron"];
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-frame-snapshot-"));
const statePath = join(profileDir, "task-spaces.json");
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
let childServer;
let parentServer;
let electron;
let host;

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
    await sleep(50);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function readBridge() {
  try {
    return JSON.parse(await readFile(bridgeFile, "utf8"));
  } catch {
    return null;
  }
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
    throw new Error(payload.error || `bridge request failed: ${pathname}`);
  }
  return payload;
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await waitFor(
    "child process shutdown",
    async () =>
      processHandle.exitCode !== null || processHandle.signalCode !== null,
    5_000,
  ).catch(() => {
    try {
      processHandle.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the final kill.
    }
  });
}

try {
  childServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      _request.url === "/clicked"
        ? "<!doctype html><html><body><h2>Clicked child</h2></body></html>"
        : "<!doctype html><html><body><h2>Nested child</h2><button id=\"child-action\" onclick=\"location.href='/clicked'\">Child action</button></body></html>",
    );
  });
  const childPort = await new Promise((resolvePromise, rejectPromise) => {
    childServer.once("error", rejectPromise);
    childServer.listen(0, "127.0.0.1", () =>
      resolvePromise(childServer.address().port),
    );
  });
  parentServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><html><body><h1>Frame fixture</h1><button id="parent-action">Parent action</button><iframe title="child" src="http://127.0.0.1:${childPort}/child"></iframe></body></html>`,
    );
  });
  const parentPort = await new Promise((resolvePromise, rejectPromise) => {
    parentServer.once("error", rejectPromise);
    parentServer.listen(0, "127.0.0.1", () =>
      resolvePromise(parentServer.address().port),
    );
  });

  electron = spawn(electronPath, electronArgs, {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_DISABLE_GPU: "1",
      EGO_LITE_SKIP_MIGRATION: "1",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let electronStdout = "";
  let electronStderr = "";
  electron.stdout.on("data", (chunk) => {
    electronStdout += chunk;
  });
  electron.stderr.on("data", (chunk) => {
    electronStderr += chunk;
  });

  const bridge = await waitFor("Electron bridge", readBridge);
  await waitFor("primary browser tab", async () => {
    const result = await bridgeRequest(bridge, "/tabs");
    return result.tabs?.find((tab) => tab.spaceId === null);
  });

  host = spawn(process.execPath, [hostPath, "nodejs"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_SKIP_MIGRATION: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let hostStdout = "";
  let hostStderr = "";
  host.stdout.on("data", (chunk) => {
    hostStdout += chunk;
  });
  host.stderr.on("data", (chunk) => {
    hostStderr += chunk;
  });
  host.stdin.end(`
await page.goto('http://127.0.0.1:${parentPort}/parent', { waitUntil: 'load' })
const before = await page.snapshotRaw()
console.log(JSON.stringify({ before }))
const child = before.refs.find((ref) => ref.name === 'Child action')
if (!child) throw new Error('nested child ref missing')
await page.locator('@' + child.backendNodeId).click()
await page.waitForTimeout(200)
const after = await page.snapshotRaw()
console.log(JSON.stringify({ after }))
`);
  const exitCode = await new Promise((resolvePromise) =>
    host.once("close", resolvePromise),
  );
  if (exitCode !== 0) {
    throw new Error(
      `ego-browser frame probe failed with exit code ${exitCode}\n${hostStdout}\n${hostStderr}`,
    );
  }
  const reports = hostStdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(reports.length, 2, hostStdout);
  const before = reports[0].before;
  const after = reports[1].after;
  const nestedRef = before.refs.find((ref) => ref.name === "Child action");
  assert.ok(nestedRef?.frameId, "nested ref should retain its frame id");
  assert.match(before.content, /Iframe "child"/);
  assert.match(before.content, /button "Child action" \[ref=/);
  assert.match(after.content, /Clicked child/);
  assert.doesNotMatch(after.content, /Child action/);
  console.log(
    JSON.stringify({
      nestedFrame: nestedRef.frameId,
      beforeHasNestedAction: before.content.includes("Child action"),
      afterHasClickedChild: after.content.includes("Clicked child"),
      electronOutput: `${electronStdout}\n${electronStderr}`.trim(),
    }),
  );
} finally {
  await stopProcess(host);
  await stopProcess(electron);
  await new Promise((resolvePromise) => childServer?.close(resolvePromise));
  await new Promise((resolvePromise) => parentServer?.close(resolvePromise));
  await rm(profileDir, { recursive: true, force: true });
}
