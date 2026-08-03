import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = resolve(repoDir, "platform/linux/ego-browser.mjs");
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";
const profileRoot = await mkdtemp(join(tmpdir(), "ego-linux-automation-"));
const profileDir = join(profileRoot, "chromium-profile");
const statePath = join(profileRoot, "task-spaces.json");

let fixtureServer;

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

async function runAutomation(request) {
  const child = spawn(process.execPath, [hostPath, "--automation"], {
    cwd: repoDir,
    env: {
      ...process.env,
      EGO_LITE_PROFILE_DIR: profileDir,
      EGO_LITE_STATE_PATH: statePath,
      EGO_LITE_HEADLESS: "1",
      EGO_BROWSER_EXECUTABLE: executable,
    },
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
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`standalone automation timed out\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(
    lines.length,
    1,
    `standalone automation must write one JSON line\nstdout=${stdout}\nstderr=${stderr}`,
  );
  return { response: JSON.parse(lines[0]), exitCode, stderr };
}

async function automation(request) {
  const result = await runAutomation(request);
  assert.equal(result.exitCode, 0, JSON.stringify(result.response));
  assert.equal(result.response.ok, true, JSON.stringify(result.response));
  return result.response.result;
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

async function closeChromium() {
  let endpoint;
  try {
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8"))
      .trim()
      .split(/\r?\n/);
    endpoint = `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return;
  }
  const connection = await new CdpConnection(endpoint).connect();
  try {
    await connection.request("Browser.close");
  } finally {
    connection.close();
  }
}

async function removeProfileRoot() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(profileRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

try {
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      nextId: 2,
      spaces: [
        {
          taskId: "standalone-space",
          id: 1,
          name: "Standalone Space",
          createdBy: "agent",
          ownership: "agent",
          createdAt: new Date().toISOString(),
          contextId: null,
          mode: "context",
          tabTargetIds: [],
        },
      ],
    })}\n`,
  );
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Standalone automation</title><main>STANDALONE_AUTOMATION</main>");
  });
  await new Promise((resolvePromise, rejectPromise) => {
    fixtureServer.once("error", rejectPromise);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
  const savedPath = join(profileRoot, "artifacts", "standalone-page.html");
  const printedPath = join(profileRoot, "artifacts", "standalone-page.pdf");

  const initial = await automation({ version: 1, action: "state" });
  assert.equal(initial.capabilities.fullWindowInventory, false);
  assert.equal(initial.window.index, 1);
  assert.equal(initial.window.activeTabIndex, 1);
  assert.equal(initial.window.mode, "normal");
  assert.equal(initial.window.closeable, null);
  assert.equal(initial.tabs.length, 1);

  const created = await automation({
    version: 1,
    action: "tab.create",
    params: { url: fixtureUrl },
  });
  assert.ok(created.tab.targetId);
  let tabId = created.tab.targetId;
  await automation({
    version: 1,
    action: "tab.navigate",
    params: { id: tabId, url: fixtureUrl },
  });
  const executed = await automation({
    version: 1,
    action: "tab.execute",
    params: { id: tabId, javascript: "document.title + ':' + document.querySelector('main').textContent" },
  });
  assert.equal(executed.value, "Standalone automation:STANDALONE_AUTOMATION");
  const saved = await automation({
    version: 1,
    action: "tab.save",
    params: { id: tabId, path: savedPath },
  });
  assert.equal(saved.saved, true);
  assert.match(await readFile(savedPath, "utf8"), /STANDALONE_AUTOMATION/);
  const printed = await automation({
    version: 1,
    action: "application.print",
    params: { id: tabId, path: printedPath },
  });
  assert.equal(printed.printed, true);
  assert.equal((await readFile(printedPath)).subarray(0, 4).toString(), "%PDF");
  const source = await automation({
    version: 1,
    action: "tab.view-source",
    params: { id: tabId },
  });
  assert.equal(
    source.state.tabs.find((tab) => tab.id === source.tab.targetId)?.url,
    `view-source:${fixtureUrl}`,
  );
  await automation({ version: 1, action: "tab.close", params: { id: source.tab.targetId } });
  for (const action of ["tab.undo", "tab.redo", "tab.cut", "tab.copy", "tab.paste", "tab.select-all"]) {
    await automation({ version: 1, action, params: { id: tabId } });
  }
  const movedIntoSpace = await automation({
    version: 1,
    action: "standard.move",
    params: {
      kind: "tab",
      id: tabId,
      to: { title: "Standalone Space" },
    },
  });
  assert.equal(movedIntoSpace.moved, true);
  assert.equal(movedIntoSpace.tab.spaceId, 1);
  const movedBackToPrimary = await automation({
    version: 1,
    action: "standard.move",
    params: {
      kind: "tab",
      id: movedIntoSpace.tab.targetId,
      sourceSpaceId: "Standalone Space",
      to: "primary",
      index: 1,
    },
  });
  assert.equal(movedBackToPrimary.moved, true);
  assert.equal(movedBackToPrimary.tab.spaceId, null);
  tabId = movedBackToPrimary.tab.targetId;

  const folderAdded = await automation({
    version: 1,
    action: "bookmark.folder.add",
    params: { title: "Standalone Folder" },
  });
  assert.equal(folderAdded.added, true);
  const nestedBookmark = await automation({
    version: 1,
    action: "bookmark.add",
    params: {
      url: `${fixtureUrl}?nested=1`,
      name: "Standalone nested",
      parentId: folderAdded.folder.id,
    },
  });
  assert.equal(nestedBookmark.bookmark.folderId, folderAdded.folder.id);
  const movableBookmark = await automation({
    version: 1,
    action: "bookmark.add",
    params: {
      url: `${fixtureUrl}?movable=1`,
      name: "Standalone movable",
    },
  });
  assert.equal(movableBookmark.added, true);
  const movedIntoFolder = await automation({
    version: 1,
    action: "bookmark.move",
    params: {
      id: movableBookmark.bookmark.id,
      parentId: folderAdded.folder.id,
      index: 1,
    },
  });
  assert.equal(movedIntoFolder.moved, true);
  assert.equal(movedIntoFolder.bookmark.parentId, folderAdded.folder.id);
  assert.equal(movedIntoFolder.bookmark.index, 1);
  const movedBackToRoot = await automation({
    version: 1,
    action: "bookmark.reorder",
    params: { id: movableBookmark.bookmark.id, parentId: "1", index: 1 },
  });
  assert.equal(movedBackToRoot.moved, true);
  assert.equal(movedBackToRoot.bookmark.parentId, "1");
  assert.equal(movedBackToRoot.bookmark.index, 1);
  const renamedFolder = await automation({
    version: 1,
    action: "bookmark.folder.rename",
    params: { id: folderAdded.folder.id, title: "Renamed Standalone Folder" },
  });
  assert.equal(renamedFolder.folder.title, "Renamed Standalone Folder");
  const removedNestedBookmark = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: nestedBookmark.bookmark.id },
  });
  assert.equal(removedNestedBookmark.removed, 1);
  const removedFolder = await automation({
    version: 1,
    action: "bookmark.folder.remove",
    params: { id: folderAdded.folder.id },
  });
  assert.equal(removedFolder.removed, 1);
  const removedMovableBookmark = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: movableBookmark.bookmark.id },
  });
  assert.equal(removedMovableBookmark.removed, 1);

  const standardTabCount = await automation({
    version: 1,
    action: "standard.count",
    params: { kind: "tabs" },
  });
  assert.equal(standardTabCount.kind, "tabs");
  assert.ok(standardTabCount.count >= 1);
  const standardWindowExists = await automation({
    version: 1,
    action: "standard.exists",
    params: { kind: "window", id: "main" },
  });
  assert.equal(standardWindowExists.exists, true);
  const standardOpened = await automation({
    version: 1,
    action: "application.open",
    params: { url: `${fixtureUrl}?standard-open=1` },
  });
  assert.equal(standardOpened.opened, true);
  const activatedBySpecifier = await automation({
    version: 1,
    action: "tab.activate",
    params: { specifier: { url: `${fixtureUrl}?standard-open=1` } },
  });
  assert.equal(activatedBySpecifier.state.activeTabId, standardOpened.tab.targetId);
  const standardDuplicate = await automation({
    version: 1,
    action: "standard.duplicate",
    params: { kind: "tab", id: standardOpened.tab.targetId },
  });
  assert.equal(standardDuplicate.duplicated, true);
  const standardExistsByUrl = await automation({
    version: 1,
    action: "standard.exists",
    params: { kind: "tab", url: `${fixtureUrl}?standard-open=1` },
  });
  assert.equal(standardExistsByUrl.exists, true);
  const standardDeletedByUrl = await automation({
    version: 1,
    action: "standard.delete",
    params: { kind: "tab", url: `${fixtureUrl}?standard-open=1` },
  });
  assert.equal(standardDeletedByUrl.deleted, true);
  const standardExistsByIndex = await automation({
    version: 1,
    action: "standard.exists",
    params: { kind: "tab", index: 2 },
  });
  assert.equal(standardExistsByIndex.exists, true);
  await automation({
    version: 1,
    action: "standard.delete",
    params: { kind: "tab", url: `${fixtureUrl}?standard-open=1` },
  });
  const standardFolder = await automation({
    version: 1,
    action: "standard.make",
    params: { kind: "bookmarkFolder", title: "Standalone standard folder" },
  });
  const nestedStandardFolder = await automation({
    version: 1,
    action: "standard.make",
    params: {
      kind: "bookmarkFolder",
      title: "Standalone nested folder",
      at: { title: "Standalone standard folder" },
    },
  });
  assert.equal(nestedStandardFolder.folder.parentId, standardFolder.folder.id);
  const standardFolderByPath = await automation({
    version: 1,
    action: "standard.exists",
    params: {
      kind: "bookmarkFolder",
      specifier: {
        path: "Bookmarks bar / Standalone standard folder / Standalone nested folder",
      },
    },
  });
  assert.equal(standardFolderByPath.exists, true);
  const standardFolderCount = await automation({
    version: 1,
    action: "standard.count",
    params: { each: "bookmark folders" },
  });
  assert.ok(standardFolderCount.count >= 3);
  const standardItem = await automation({
    version: 1,
    action: "standard.make",
    params: {
      kind: "bookmarkItem",
      url: `${fixtureUrl}?standard-item=1`,
      name: "Standalone standard item",
    },
  });
  const nestedStandardItem = await automation({
    version: 1,
    action: "standard.make",
    params: {
      kind: "bookmarkItem",
      withProperties: {
        url: `${fixtureUrl}?nested-standard-item=1`,
        title: "Standalone nested item",
      },
      at: {
        path: "Bookmarks bar / Standalone standard folder / Standalone nested folder",
      },
    },
  });
  assert.equal(nestedStandardItem.bookmark.parentId, nestedStandardFolder.folder.id);
  const movedNestedStandardItem = await automation({
    version: 1,
    action: "standard.move",
    params: {
      kind: "bookmarkItem",
      specifier: { title: "Standalone nested item" },
      to: { title: "Standalone standard folder" },
      index: 1,
    },
  });
  assert.equal(movedNestedStandardItem.bookmark.parentId, standardFolder.folder.id);
  const deletedNestedStandardItem = await automation({
    version: 1,
    action: "standard.delete",
    params: {
      kind: "bookmarkItem",
      specifier: { title: "Standalone nested item" },
    },
  });
  assert.equal(deletedNestedStandardItem.deleted, true);
  const standardMoved = await automation({
    version: 1,
    action: "standard.move",
    params: {
      kind: "bookmarkItem",
      id: standardItem.bookmark.id,
      parentId: standardFolder.folder.id,
      index: 1,
    },
  });
  assert.equal(standardMoved.bookmark.parentId, standardFolder.folder.id);
  const standardExistsItem = await automation({
    version: 1,
    action: "standard.exists",
    params: { kind: "bookmarkItem", id: standardItem.bookmark.id },
  });
  assert.equal(standardExistsItem.exists, true);
  const standardDuplicateItem = await automation({
    version: 1,
    action: "standard.duplicate",
    params: { kind: "bookmarkItem", id: standardItem.bookmark.id },
  });
  assert.equal(standardDuplicateItem.duplicated, true);
  await automation({
    version: 1,
    action: "standard.delete",
    params: { kind: "bookmarkItem", id: standardDuplicateItem.bookmark.id },
  });
  await automation({
    version: 1,
    action: "standard.delete",
    params: { kind: "bookmarkItem", id: standardItem.bookmark.id },
  });
  const standardDeletedFolder = await automation({
    version: 1,
    action: "standard.delete",
    params: { kind: "bookmarkFolder", id: standardFolder.folder.id },
  });
  assert.equal(standardDeletedFolder.deleted, true);

  const added = await automation({
    version: 1,
    action: "bookmark.add",
    params: { url: fixtureUrl, name: "Standalone fixture" },
  });
  assert.equal(added.added, true);
  const bookmark = added.bookmark;
  const opened = await automation({
    version: 1,
    action: "bookmark.open",
    params: { id: bookmark.id },
  });
  assert.equal(opened.bookmark.url, fixtureUrl);
  const toggledOff = await automation({ version: 1, action: "bookmark.toggle" });
  assert.equal(toggledOff.bookmarked, false);
  const toggledOn = await automation({ version: 1, action: "bookmark.toggle" });
  assert.equal(toggledOn.bookmarked, true);
  const removed = await automation({
    version: 1,
    action: "bookmark.remove",
    params: { id: bookmark.id },
  });
  assert.equal(removed.removed, 1);
  await automation({ version: 1, action: "tab.close", params: { id: tabId } });

  const unsupportedQuit = await runAutomation({
    version: 1,
    action: "application.quit",
  });
  assert.equal(unsupportedQuit.exitCode, 1);
  assert.equal(unsupportedQuit.response.error.code, "EGO_AUTOMATION_UNSUPPORTED");

  const invalid = await runAutomation({ version: 1, action: "not-real" });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.response.error.code, "EGO_AUTOMATION_UNKNOWN_ACTION");

  console.log("standalone automation contract: passed");
} finally {
  await closeChromium().catch(() => {});
  fixtureServer?.close();
  await removeProfileRoot();
}
