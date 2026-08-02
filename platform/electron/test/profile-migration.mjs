import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoDir = new URL("../../..", import.meta.url).pathname;
const hostPath = join(repoDir, "platform/linux/ego-browser.mjs");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const root = await mkdtemp(join(tmpdir(), "ego-profile-migration-"));
const sourceUserData = join(root, "source-browser");
const sourceProfile = join(sourceUserData, "Default");
const targetUserData = join(root, "ego-profile");
const targetProfile = join(targetUserData, "Default");
const statePath = join(root, "state", "task-spaces.json");

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
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
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

async function readEndpoint(userDataDir) {
  try {
    const lines = (
      await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return null;
  }
}

async function waitForEndpoint(userDataDir) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const endpoint = await readEndpoint(userDataDir);
    if (endpoint) {
      const connection = new CdpConnection(endpoint);
      try {
        return await connection.connect();
      } catch {
        connection.close();
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Chromium did not expose CDP for ${userDataDir}`);
}

async function startBrowser(userDataDir) {
  await mkdir(userDataDir, { recursive: true });
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--noerrdialogs",
    ],
    { stdio: "ignore" },
  );
  const connection = await waitForEndpoint(userDataDir);
  return { child, connection };
}

async function attachPage(connection) {
  const targets = await connection.request("Target.getTargets");
  const page = targets.targetInfos.find((target) => target.type === "page");
  const attached = await connection.request("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  return attached.sessionId;
}

async function stopBrowser(browser) {
  await browser.connection.request("Browser.close").catch(() => {});
  browser.connection.close();
  if (browser.child.exitCode !== null) return;
  await new Promise((resolvePromise) => {
    let forceTimer;
    const timer = setTimeout(() => {
      browser.child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        browser.child.kill("SIGKILL");
        resolvePromise();
      }, 2000);
    }, 3000);
    browser.child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise();
    });
  });
}

async function runMigration() {
  const child = spawn(
    process.execPath,
    [hostPath, "--migrate-profile", "--from", sourceUserData],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        EGO_LITE_PROFILE_DIR: targetUserData,
        EGO_LITE_STATE_PATH: statePath,
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
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  if (code !== 0)
    throw new Error(`migration failed (${code})\n${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}

try {
  await mkdir(sourceProfile, { recursive: true });
  await mkdir(targetProfile, { recursive: true });
  const bookmarks = JSON.stringify(
    {
      checksum: "fixture",
      roots: {
        bookmark_bar: {
          children: [
            {
              date_added: "13200000000000000",
              id: "2",
              name: "Migrated fixture",
              type: "url",
              url: "https://example.com/fixture",
            },
          ],
          name: "Bookmarks bar",
          type: "folder",
        },
      },
      version: 1,
    },
    null,
    2,
  );
  await writeFile(join(sourceProfile, "Bookmarks"), `${bookmarks}\n`);
  await writeFile(
    join(sourceProfile, "Preferences"),
    JSON.stringify({ profile: { name: "Migrated fixture" } }) + "\n",
  );
  await writeFile(join(targetProfile, "Bookmarks"), '{"old":true}\n');

  const sourceBrowser = await startBrowser(sourceUserData);
  try {
    const sessionId = await attachPage(sourceBrowser.connection);
    await sourceBrowser.connection.request("Network.enable", {}, sessionId);
    await sourceBrowser.connection.request(
      "Network.setCookies",
      {
        cookies: [
          {
            url: "https://example.com/",
            name: "ego_migration_fixture",
            value: "imported",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ],
      },
      sessionId,
    );
    const cookies = await sourceBrowser.connection.request(
      "Network.getAllCookies",
      {},
      sessionId,
    );
    if (
      !cookies.cookies?.some(
        (cookie) => cookie.name === "ego_migration_fixture",
      )
    ) {
      throw new Error(`source cookie was not set: ${JSON.stringify(cookies)}`);
    }
  } finally {
    await stopBrowser(sourceBrowser);
  }

  const reopenedSourceBrowser = await startBrowser(sourceUserData);
  try {
    const sessionId = await attachPage(reopenedSourceBrowser.connection);
    const cookies = await reopenedSourceBrowser.connection.request(
      "Network.getAllCookies",
      {},
      sessionId,
    );
    if (
      !cookies.cookies?.some(
        (cookie) => cookie.name === "ego_migration_fixture",
      )
    ) {
      throw new Error(
        `source cookie was not persisted: ${JSON.stringify(cookies)}`,
      );
    }
  } finally {
    await stopBrowser(reopenedSourceBrowser);
  }

  const report = await runMigration();
  const migratedBookmarks = await readFile(
    join(targetProfile, "Bookmarks"),
    "utf8",
  );
  if (migratedBookmarks !== `${bookmarks}\n`) {
    throw new Error("Bookmarks were not migrated exactly");
  }
  if (!report.backupDir)
    throw new Error("migration did not report a backup directory");
  const backupBookmarks = await readFile(
    join(report.backupDir, "Bookmarks"),
    "utf8",
  );
  if (backupBookmarks !== '{"old":true}\n') {
    throw new Error("existing target data was not backed up");
  }
  if (report.cookies.imported < 1) {
    throw new Error(
      `migration did not import the fixture cookie: ${JSON.stringify(report)}`,
    );
  }

  const targetBrowser = await startBrowser(targetUserData);
  try {
    const sessionId = await attachPage(targetBrowser.connection);
    const cookies = await targetBrowser.connection.request(
      "Network.getAllCookies",
      {},
      sessionId,
    );
    const imported = cookies.cookies?.find(
      (cookie) => cookie.name === "ego_migration_fixture",
    );
    if (imported?.value !== "imported") {
      throw new Error(
        `target cookie was not readable: ${JSON.stringify(cookies)}`,
      );
    }
  } finally {
    await stopBrowser(targetBrowser);
  }
  console.log(JSON.stringify(report));
} finally {
  await rm(root, { recursive: true, force: true });
}
