import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoDir = resolve(import.meta.dirname, "../../..");
const hostPath = join(repoDir, "platform/linux/ego-browser.mjs");
const profileDir = await mkdtemp(join(tmpdir(), "ego-stale-cdp-probe-"));
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
let child;

function waitForClose(processHandle, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`probe exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    processHandle.once("error", rejectPromise);
    processHandle.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

try {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await writeFile(
    join(profileDir, "DevToolsActivePort"),
    `${port}\n/devtools/browser/unresponsive\n`,
  );

  const startedAt = Date.now();
  child = spawn(process.execPath, [hostPath, "--reload"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
    },
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

  const result = await waitForClose(child, 5_000);
  assert.equal(result.code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /No running Linux browser connection found/);
  console.log(
    JSON.stringify({
      completedWithinMs: Date.now() - startedAt,
      staleEndpointRejected: true,
    }),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(profileDir, { recursive: true, force: true });
}
