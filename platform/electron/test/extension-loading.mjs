import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const electronPath = resolve(
  process.env.EGO_LITE_ELECTRON_EXECUTABLE ||
    resolve(testDir, "../node_modules/.bin/electron"),
);
const profileDir = await mkdtemp(join(tmpdir(), "ego-electron-extension-"));
const extensionDir = join(
  profileDir,
  "Default",
  "Extensions",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "1.0.0",
);
const bridgeFile = join(profileDir, "ego-lite-bridge.json");
const environment = {
  ...process.env,
  EGO_LITE_PROFILE_DIR: profileDir,
  EGO_LITE_STATE_PATH: join(profileDir, "task-spaces.json"),
  EGO_LITE_DISABLE_GPU: "1",
  EGO_LITE_SKIP_MIGRATION: "1",
  EGO_LITE_DISABLE_AUTO_UPDATE: "1",
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

async function targetInfos(connection) {
  return (await connection.request("Target.getTargets")).targetInfos || [];
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.request(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "DOM evaluation failed");
  }
  return result.result?.value;
}

async function readBridge() {
  return JSON.parse(
    await readFile(join(profileDir, "ego-lite-bridge.json"), "utf8"),
  );
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

try {
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Migrated extension fixture",
        version: "1.0.0",
        background: { service_worker: "background.js" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(extensionDir, "background.js"),
    'console.log("migrated extension fixture started");\n',
  );

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
    const extensionTarget = await waitFor(
      "migrated extension target",
      async () => {
        const targets = await targetInfos(connection);
        return targets.find(
          (target) =>
            ["service_worker", "background_page"].includes(target.type) &&
            target.url.startsWith("chrome-extension://"),
        );
      },
    );
    const extensionId = extensionTarget.url.split("/")[2];
    const toolbar = await waitFor("toolbar target", async () =>
      (await targetInfos(connection)).find((target) =>
        target.url.includes("/renderer/index.html"),
      ),
    );
    const attachedToolbar = await connection.request("Target.attachToTarget", {
      targetId: toolbar.targetId,
      flatten: true,
    });
    const extensionMenu = await waitFor("extension toolbar menu", async () => {
      const value = await evaluate(
        connection,
        attachedToolbar.sessionId,
        "(() => ({visible: !document.querySelector('#extension-menu').hidden, labels: [...document.querySelectorAll('#extension-list .extension-row span')].map((node) => node.textContent), enabled: document.querySelector('#extension-list input')?.checked === true}))()",
      );
      return value?.visible ? value : null;
    });
    const bridge = await waitFor("Electron bridge", readBridge);
    const created = await bridgeRequest(bridge, "/create-tab", {
      spaceId: 1,
      spaceName: "extension parity",
      url: "about:blank",
    });
    const extensionTargets = await waitFor(
      "task Space extension target",
      async () => {
        const targets = (await targetInfos(connection)).filter(
          (target) =>
            ["service_worker", "background_page"].includes(target.type) &&
            target.url.startsWith("chrome-extension://"),
        );
        return targets.length >= 2 ? targets : null;
      },
    );
    const disabled = await evaluate(
      connection,
      attachedToolbar.sessionId,
      `window.egoLite.setExtension(${JSON.stringify({ id: extensionId, enabled: false })}).then((state) => state.extensions.find((extension) => extension.id === ${JSON.stringify(extensionId)}))`,
    );
    await waitFor("extension disable", async () => {
      const targets = await targetInfos(connection);
      return targets.some((target) => target.url.includes(extensionId))
        ? null
        : true;
    });
    const reenabled = await evaluate(
      connection,
      attachedToolbar.sessionId,
      `window.egoLite.setExtension(${JSON.stringify({ id: extensionId, enabled: true })}).then((state) => state.extensions.find((extension) => extension.id === ${JSON.stringify(extensionId)}))`,
    );
    await waitFor("extension re-enable", async () => {
      const targets = await targetInfos(connection);
      return targets.some((target) => target.url.includes(extensionId))
        ? true
        : null;
    });
    await bridgeRequest(bridge, "/close-tab", { targetId: created.targetId });
    console.log(
      JSON.stringify({
        extensionId: extensionTarget.url.split("/")[2],
        targetType: extensionTarget.type,
        targetUrl: extensionTarget.url,
        sessionExtensionTargets: extensionTargets.length,
        extensionMenu,
        disabled,
        reenabled,
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
