import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(testDir, "../node_modules/.bin/electron");
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-agent-visuals-"));
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const environment = {
  ...process.env,
  EGO_LITE_PROFILE_DIR: profileDir,
  EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
  EGO_LITE_DISABLE_GPU: "1",
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

  request(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.socket?.close();
  }
}

async function readEndpoint() {
  try {
    const lines = (
      await readFile(join(profileDir, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
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
    throw new Error(payload.error || `bridge request failed: ${pathname}`);
  }
  return payload;
}

async function attachTarget(connection, targetId) {
  return (
    await connection.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    })
  ).sessionId;
}

async function evaluate(
  connection,
  targetId,
  expression,
  { awaitPromise = false } = {},
) {
  const sessionId = await attachTarget(connection, targetId);
  const result = await connection.request(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
  }
  const value = result.result?.value;
  if (value === undefined) {
    throw new Error(
      `Runtime.evaluate returned no value: ${JSON.stringify(result)}`,
    );
  }
  return value;
}

try {
  const bridge = await waitFor("Electron bridge", readBridge);
  const connection = await waitFor("Electron CDP endpoint", async () => {
    const endpoint = await readEndpoint();
    if (!endpoint) return null;
    const candidate = new CdpConnection(endpoint);
    try {
      return await candidate.connect();
    } catch {
      candidate.close();
      return null;
    }
  });
  try {
    const primary = await waitFor("primary browser tab", async () => {
      const result = await bridgeRequest(bridge, "/tabs");
      return result.tabs?.find((tab) => tab.spaceId === null) || null;
    });
    const shellTarget = await waitFor("Electron toolbar", async () => {
      const result = await connection.request("Target.getTargets");
      const target = result.targetInfos?.find(
        (target) =>
          target.type === "page" && target.url.includes("/renderer/index.html"),
      );
      if (!target) return null;
      return (await evaluate(
        connection,
        target.targetId,
        'Boolean(document.querySelector("#status"))',
      ))
        ? target
        : null;
    });

    const state = await bridgeRequest(bridge, "/agent-state", {
      label: "inspect parity state",
    });
    const queriedBrowserState = await evaluate(
      connection,
      shellTarget.targetId,
      "window.egoLite.getBrowserState()",
      { awaitPromise: true },
    );
    let latestToolbarValue;
    const toolbarState = await waitFor(
      "agent task state",
      async () => {
        latestToolbarValue = await evaluate(
          connection,
          shellTarget.targetId,
          '({ href: location.href, status: document.querySelector("#status")?.textContent, body: document.body?.innerText?.slice(0, 120) })',
        );
        return latestToolbarValue?.status === state.agentTaskState
          ? latestToolbarValue.status
          : (() => {
              throw new Error(
                `toolbar status is ${JSON.stringify({ latestToolbarValue, queriedBrowserState })}`,
              );
            })();
      },
      5000,
    );

    const highlighted = await bridgeRequest(bridge, "/highlight", {
      targetId: primary.targetId,
      x: 120,
      y: 80,
    });
    const marker = await waitFor("agent pointer highlight", async () =>
      evaluate(
        connection,
        primary.targetId,
        'Boolean(document.getElementById("ego-lite-agent-pointer-highlight"))',
      ),
    );
    if (!highlighted.highlighted || !marker) {
      throw new Error(
        `agent visuals did not render: ${JSON.stringify({ highlighted, marker })}`,
      );
    }
    console.log(
      JSON.stringify({
        agentTaskState: toolbarState,
        highlighted: highlighted.highlighted,
        markerPresent: marker,
      }),
    );
  } finally {
    connection.close();
  }
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
