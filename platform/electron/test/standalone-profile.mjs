import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = resolve(repoDir, "platform/linux/ego-browser.mjs");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const profileRoot = await mkdtemp(join(tmpdir(), "ego-linux-profile-cli-"));
const stateHome = join(profileRoot, "state");
const profileDir = join(
  profileRoot,
  "servers",
  "ci",
  "profiles",
  "work",
  "chromium-profile",
);
const statePath = join(
  stateHome,
  "ego-lite",
  "servers",
  "ci",
  "profiles",
  "work",
  "task-spaces.json",
);

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

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function readEndpoint() {
  try {
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8"))
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function runDoctor() {
  const child = spawn(
    process.execPath,
    [hostPath, "--profile", "work", "--server-name", "ci", "--doctor"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        EGO_LITE_PROFILE_ROOT: profileRoot,
        XDG_STATE_HOME: stateHome,
        EGO_LITE_HEADLESS: "1",
        EGO_BROWSER_EXECUTABLE: executable,
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
  const code = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`standalone profile doctor timed out\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise(exitCode);
    });
  });
  assert.equal(code, 0, `standalone doctor failed\n${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}

async function closeDetachedChromium() {
  const endpoint = await waitFor("standalone Chromium endpoint", readEndpoint);
  const connection = await new CdpConnection(endpoint).connect();
  try {
    await connection.request("Browser.close");
  } finally {
    connection.close();
  }
}

try {
  const report = await runDoctor();
  assert.equal(report.profileId, "work");
  assert.equal(report.serverName, "ci");
  assert.equal(report.profileDir, profileDir);
  assert.equal(report.statePath, statePath);
  await closeDetachedChromium();
  console.log(
    JSON.stringify({
      profileId: report.profileId,
      serverName: report.serverName,
      profileDir: report.profileDir,
      statePath: report.statePath,
    }),
  );
} finally {
  await rm(profileRoot, { recursive: true, force: true });
}
