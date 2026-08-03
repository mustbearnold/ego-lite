import { randomUUID } from "node:crypto";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const AUTOMATION_VERSION = 1;

const AUTOMATION_ACTIONS = new Set([
  "state",
  "window.get",
  "window.focus",
  "window.fullscreen",
  "tabs.list",
  "spaces.list",
  "tab.create",
  "tab.activate",
  "tab.close",
  "tab.navigate",
  "tab.back",
  "tab.forward",
  "tab.reload",
  "tab.stop",
  "tab.mute",
  "tab.undo",
  "tab.redo",
  "tab.cut",
  "tab.copy",
  "tab.paste",
  "tab.select-all",
  "tab.execute",
  "tab.save",
  "tab.print",
  "tab.view-source",
  "bookmarks.list",
  "bookmark.add",
  "bookmark.remove",
  "bookmark.open",
  "bookmark.toggle",
]);

const BOOKMARK_PROTOCOLS = new Set(["file:", "http:", "https:"]);

export function automationSuccess(result) {
  return { version: AUTOMATION_VERSION, ok: true, result };
}

export function automationFailure(code, message, details = undefined) {
  return {
    version: AUTOMATION_VERSION,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function parseAutomationRequest(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return automationFailure(
        "EGO_AUTOMATION_INVALID_JSON",
        "automation input must be valid JSON",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return automationFailure(
      "EGO_AUTOMATION_INVALID_REQUEST",
      "automation request must be a JSON object",
    );
  }
  if (value.version !== AUTOMATION_VERSION) {
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED_VERSION",
      `automation version must be ${AUTOMATION_VERSION}`,
      { received: value.version ?? null, supported: [AUTOMATION_VERSION] },
    );
  }
  if (typeof value.action !== "string" || !AUTOMATION_ACTIONS.has(value.action)) {
    return automationFailure(
      "EGO_AUTOMATION_UNKNOWN_ACTION",
      `unsupported automation action: ${String(value.action || "")}`,
      { supported: [...AUTOMATION_ACTIONS].sort() },
    );
  }
  if (
    value.params !== undefined &&
    (!value.params || typeof value.params !== "object" || Array.isArray(value.params))
  ) {
    return automationFailure(
      "EGO_AUTOMATION_INVALID_PARAMS",
      "automation params must be a JSON object",
    );
  }
  return {
    version: AUTOMATION_VERSION,
    action: value.action,
    params: value.params || {},
  };
}

function validBookmarkUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return BOOKMARK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function visitBookmarkNode(node, folder, result) {
  if (!node || result.length >= 200) return;
  if (node.type === "url") {
    const url = validBookmarkUrl(node.url);
    const name = String(node.name || "").trim();
    if (url && name) {
      result.push({
        id: String(node.id || `${result.length + 1}`),
        name: name.slice(0, 160),
        url,
        folder: folder.join(" / "),
      });
    }
    return;
  }
  if (!Array.isArray(node.children)) return;
  const nextFolder = node.name ? [...folder, String(node.name).trim()] : folder;
  if (nextFolder.length > 6) return;
  for (const child of node.children) visitBookmarkNode(child, nextFolder, result);
}

function parseBookmarkDocument(document) {
  const result = [];
  for (const root of Object.values(document?.roots || {})) {
    visitBookmarkNode(root, [], result);
    if (result.length >= 200) break;
  }
  return result;
}

async function readBookmarkDocument(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { roots: {} };
  } catch {
    return { roots: {} };
  }
}

async function readStandaloneBookmarks(profileDir) {
  const path = join(profileDir, "Default", "Bookmarks");
  return parseBookmarkDocument(await readBookmarkDocument(path));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function ensureBookmarkBar(document) {
  const next = clone(document);
  next.roots ||= {};
  next.roots.bookmark_bar ||= {
    children: [],
    date_added: "0",
    date_modified: "0",
    id: "1",
    name: "Bookmarks bar",
    type: "folder",
  };
  next.roots.bookmark_bar.children ||= [];
  next.version = Number(next.version) || 1;
  return next;
}

function nextBookmarkId(document) {
  let largest = 0;
  function visit(node) {
    const id = Number(node?.id);
    if (Number.isInteger(id)) largest = Math.max(largest, id);
    for (const child of node?.children || []) visit(child);
  }
  for (const root of Object.values(document?.roots || {})) visit(root);
  return String(largest + 1);
}

function addBookmark(document, { url, name }) {
  const canonical = validBookmarkUrl(url);
  const title = String(name || "").trim().slice(0, 160);
  if (!canonical || !title) return { document: clone(document), added: false };
  const next = ensureBookmarkBar(document);
  const existing = parseBookmarkDocument(next).find(
    (bookmark) => bookmark.url === canonical,
  );
  if (existing) return { document: next, added: false, bookmark: existing };
  const bookmark = {
    date_added: String((Date.now() + 11644473600000) * 1000),
    guid: randomUUID(),
    id: nextBookmarkId(next),
    name: title,
    type: "url",
    url: canonical,
  };
  next.roots.bookmark_bar.children.push(bookmark);
  return {
    document: next,
    added: true,
    bookmark: { id: bookmark.id, name: bookmark.name, url: bookmark.url, folder: "Bookmarks bar" },
  };
}

function removeBookmark(document, url) {
  const canonical = validBookmarkUrl(url);
  const next = clone(document);
  let removed = 0;
  function visit(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      if (child?.type === "url" && validBookmarkUrl(child.url) === canonical) {
        removed += 1;
        return false;
      }
      visit(child);
      return true;
    });
  }
  if (canonical) {
    for (const root of Object.values(next.roots || {})) visit(root);
  }
  return { document: next, removed };
}

async function writeBookmarkDocument(profileDir, document) {
  const path = join(profileDir, "Default", "Bookmarks");
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.automation.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporaryPath, path);
}

function targetId(params, selectedTargetId) {
  const value = params.id ?? params.targetId ?? selectedTargetId;
  return value ? String(value) : null;
}

function automationSelectionPath(host) {
  return join(dirname(host.statePath), "automation-selection.json");
}

async function readAutomationSelection(host) {
  try {
    const parsed = JSON.parse(
      await readFile(automationSelectionPath(host), "utf8"),
    );
    return typeof parsed?.targetId === "string" ? parsed.targetId : null;
  } catch {
    return null;
  }
}

async function setAutomationSelection(host, targetIdValue) {
  const path = automationSelectionPath(host);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: AUTOMATION_VERSION, targetId: targetIdValue })}\n`,
  );
  await rename(temporaryPath, path);
  host.selectedTargetId = targetIdValue || null;
}

async function selectAutomationTarget(host, params = {}, tabs = null) {
  const listedTabs = tabs || (await host.listTabs()).tabs || [];
  const rememberedTargetId = await readAutomationSelection(host);
  const selected = targetId(
    params,
    rememberedTargetId ||
      host.selectedTargetId ||
      listedTabs.find((tab) => tab.active)?.targetId,
  );
  if (selected && listedTabs.some((tab) => tab.targetId === selected)) {
    host.selectedTargetId = selected;
  }
  return selected;
}

async function targetSession(host, id) {
  const tabs = await host.allTargets();
  const target = tabs.find((candidate) => candidate.targetId === id && candidate.type === "page");
  if (!target) throw new Error(`target not found: ${id}`);
  const sessionId = await host.attachTarget(id);
  return { target, sessionId };
}

function automationOutputPath(value, message) {
  const path = String(value || "").trim();
  if (!path) throw new Error(message);
  return resolve(path);
}

function runtimeValue(result) {
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.description ||
        "page JavaScript failed",
    );
  }
  return result.result?.value;
}

async function standaloneTabCommand(host, request) {
  const id = await selectAutomationTarget(host, request.params);
  if (!id) throw new Error("a target id is required");
  await setAutomationSelection(host, id);

  if (request.action === "tab.view-source") {
    const { sessionId } = await targetSession(host, id);
    let url;
    try {
      url = runtimeValue(
        await host.connection.request(
          "Runtime.evaluate",
          {
            expression: "location.href",
            returnByValue: true,
          },
          sessionId,
        ),
      );
    } finally {
      await host.connection
        .request("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    }
    const parsed = new URL(String(url || ""));
    if (!["file:", "http:", "https:"].includes(parsed.protocol)) {
      throw new Error("view source is available for web pages and local files");
    }
    const result = await host.createTab(`view-source:${parsed.toString()}`);
    await setAutomationSelection(host, result.targetId);
    return { tab: result, state: await standaloneState(host) };
  }

  const { sessionId } = await targetSession(host, id);
  try {
    const editCommands = {
      "tab.undo": "undo",
      "tab.redo": "redo",
      "tab.cut": "cut",
      "tab.copy": "copy",
      "tab.paste": "paste",
      "tab.select-all": "selectAll",
    };
    if (editCommands[request.action]) {
      const executed = runtimeValue(
        await host.connection.request(
          "Runtime.evaluate",
          {
            expression: `document.execCommand(${JSON.stringify(editCommands[request.action])})`,
            returnByValue: true,
          },
          sessionId,
        ),
      );
      return { command: editCommands[request.action], executed: Boolean(executed) };
    }
    if (request.action === "tab.execute") {
      const javascript = String(request.params.javascript ?? request.params.script ?? "");
      if (!javascript.trim()) throw new Error("tab.execute requires params.javascript");
      const result = await host.connection.request(
        "Runtime.evaluate",
        {
          expression: javascript,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      return { value: runtimeValue(result) ?? null };
    }
    if (request.action === "tab.save") {
      const path = automationOutputPath(
        request.params.path,
        "tab.save requires params.path",
      );
      const format = String(request.params.as || "complete html")
        .trim()
        .toLowerCase();
      if (["single file", "mhtml"].includes(format)) {
        const result = await host.connection.request(
          "Page.captureSnapshot",
          { format: "mhtml" },
          sessionId,
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, result.data || "", "utf8");
      } else {
        const html = runtimeValue(
          await host.connection.request(
            "Runtime.evaluate",
            {
              expression: `(() => {
                const doctype = document.doctype ? '<!doctype ' + document.doctype.name + '>\\n' : '';
                return doctype + document.documentElement.outerHTML;
              })()`,
              returnByValue: true,
            },
            sessionId,
          ),
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, String(html || ""), "utf8");
      }
      return { saved: true, path };
    }
    if (request.action === "tab.print") {
      const path = automationOutputPath(
        request.params.path,
        "tab.print requires params.path",
      );
      const result = await host.connection.request(
        "Page.printToPDF",
        { printBackground: true, preferCSSPageSize: true },
        sessionId,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(result.data || "", "base64"));
      return { printed: true, path, mode: "pdf" };
    }
  } finally {
    await host.connection
      .request("Target.detachFromTarget", { sessionId })
      .catch(() => {});
  }
  throw new Error(`unsupported standalone tab command: ${request.action}`);
}

async function standaloneState(host) {
  const listedTabs = (await host.listTabs()).tabs || [];
  const rememberedTargetId = await readAutomationSelection(host);
  const activeTabId =
    (rememberedTargetId &&
      listedTabs.some((tab) => tab.targetId === rememberedTargetId) &&
      rememberedTargetId) ||
    host.selectedTargetId ||
    listedTabs.find((tab) => tab.active)?.targetId ||
    listedTabs[0]?.targetId ||
    null;
  if (activeTabId) host.selectedTargetId = activeTabId;
  const spaces = (await host.listTaskSpaces()).taskSpaces || [];
  return {
    platform: "linux",
    profileId: host.profileId || "default",
    serverName: host.serverName || "default",
    window: {
      id: "main",
      title: host.isElectron ? "ego lite" : "Chromium",
      active: true,
      visible: !Boolean(process.env.EGO_LITE_HEADLESS),
      minimized: false,
      maximized: false,
      fullscreen: false,
      bounds: null,
    },
    scope: host.currentSpace()?.id ?? null,
    activeTabId,
    tabs: listedTabs.map((tab) => ({
      id: tab.targetId,
      ...tab,
      active: tab.targetId === activeTabId,
    })),
    taskSpaces: spaces,
    bookmarks: await readStandaloneBookmarks(host.profileDir),
    capabilities: {
      windowActions: false,
      tabActions: true,
      bookmarkActions: true,
      fullWindowInventory: false,
    },
  };
}

async function standaloneTabAction(host, request) {
  const params = request.params;
  const id = await selectAutomationTarget(host, params);
  if (!id) throw new Error("a target id is required");
  await setAutomationSelection(host, id);
  const { sessionId } = await targetSession(host, id);
  try {
    const method = {
      "tab.back": "history.back()",
      "tab.forward": "history.forward()",
    }[request.action];
    if (method) {
      await host.connection.request("Runtime.evaluate", {
        expression: method,
      }, sessionId);
    } else if (request.action === "tab.reload") {
      await host.connection.request("Page.reload", {}, sessionId);
    } else if (request.action === "tab.stop") {
      await host.connection.request("Page.stopLoading", {}, sessionId);
    } else if (request.action === "tab.navigate") {
      const url = String(params.url || "").trim();
      if (!url) throw new Error("tab.navigate requires params.url");
      await host.connection.request("Page.navigate", { url }, sessionId);
    } else if (request.action === "tab.mute") {
      await host.connection.request("Runtime.evaluate", {
        expression: `document.querySelector('body') && true`,
      }, sessionId);
      throw new Error("tab.mute is only available in the Electron desktop host");
    }
  } finally {
    await host.connection.request("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  if (request.action === "tab.activate") await host.activateTarget(id);
  return standaloneState(host);
}

export async function runStandaloneAutomation(host, request) {
  if (request.action === "state") return automationSuccess(await standaloneState(host));
  if (request.action === "window.get") {
    const state = await standaloneState(host);
    return automationSuccess({ window: state.window, activeTabId: state.activeTabId });
  }
  if (request.action === "tabs.list") {
    const state = await standaloneState(host);
    return automationSuccess({ tabs: state.tabs });
  }
  if (request.action === "spaces.list") {
    return automationSuccess(await host.listTaskSpaces());
  }
  if (request.action === "window.focus" || request.action === "window.fullscreen") {
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED",
      `${request.action} is only available in the Electron desktop host`,
    );
  }
  if (request.action === "tab.create") {
    if (request.params.spaceId !== undefined && request.params.spaceId !== null) {
      await host.useTaskSpace(Number(request.params.spaceId));
    }
    const result = await host.createTab(request.params.url || "about:blank");
    await setAutomationSelection(host, result.targetId);
    return automationSuccess({ tab: result, state: await standaloneState(host) });
  }
  if (request.action === "tab.activate") {
    const id = await selectAutomationTarget(host, request.params);
    await host.activateTarget(id);
    await setAutomationSelection(host, id);
    return automationSuccess({ state: await standaloneState(host) });
  }
  if (request.action === "tab.close") {
    const id = await selectAutomationTarget(host, request.params);
    await host.closeTarget(id);
    const remaining = (await host.listTabs()).tabs || [];
    await setAutomationSelection(
      host,
      remaining.find((tab) => tab.targetId !== id)?.targetId || null,
    );
    return automationSuccess({ closed: true, state: await standaloneState(host) });
  }
  if (request.action.startsWith("tab.")) {
    if (
      [
        "tab.undo",
        "tab.redo",
        "tab.cut",
        "tab.copy",
        "tab.paste",
        "tab.select-all",
        "tab.execute",
        "tab.save",
        "tab.print",
        "tab.view-source",
      ].includes(request.action)
    ) {
      return automationSuccess(await standaloneTabCommand(host, request));
    }
    return automationSuccess({ state: await standaloneTabAction(host, request) });
  }
  if (request.action === "bookmarks.list") {
    return automationSuccess({ bookmarks: await readStandaloneBookmarks(host.profileDir) });
  }
  if (request.action === "bookmark.add") {
    const document = await readBookmarkDocument(join(host.profileDir, "Default", "Bookmarks"));
    const result = addBookmark(document, request.params);
    if (result.added) await writeBookmarkDocument(host.profileDir, result.document);
    return automationSuccess({
      added: result.added,
      bookmark: result.bookmark || null,
      bookmarks: await readStandaloneBookmarks(host.profileDir),
    });
  }
  if (request.action === "bookmark.remove") {
    const bookmarkDocumentPath = join(host.profileDir, "Default", "Bookmarks");
    const existingBookmarks = await readStandaloneBookmarks(host.profileDir);
    const selected = request.params.id
      ? existingBookmarks.find(
          (bookmark) => bookmark.id === String(request.params.id),
        )
      : null;
    const url = request.params.url || selected?.url;
    const document = await readBookmarkDocument(bookmarkDocumentPath);
    const result = removeBookmark(document, url);
    if (result.removed) await writeBookmarkDocument(host.profileDir, result.document);
    return automationSuccess({ removed: result.removed, bookmarks: await readStandaloneBookmarks(host.profileDir) });
  }
  if (request.action === "bookmark.open") {
    const bookmarks = await readStandaloneBookmarks(host.profileDir);
    const bookmark = bookmarks.find(
      (candidate) =>
        (request.params.id && candidate.id === String(request.params.id)) ||
        (request.params.url && candidate.url === String(request.params.url)) ||
        (request.params.name && candidate.name === String(request.params.name)),
    );
    if (!bookmark) throw new Error("bookmark not found");
    const result = await host.createTab(bookmark.url);
    await setAutomationSelection(host, result.targetId);
    return automationSuccess({ bookmark, tab: result, state: await standaloneState(host) });
  }
  if (request.action === "bookmark.toggle") {
    const currentTabs = await host.listTabs();
    const id = await selectAutomationTarget(host, request.params, currentTabs.tabs);
    if (!id) throw new Error("bookmark.toggle requires an active tab");
    const { sessionId } = await targetSession(host, id);
    let page;
    try {
      page = await host.connection.request(
        "Runtime.evaluate",
        {
          expression: "({ url: location.href, name: document.title })",
          returnByValue: true,
        },
        sessionId,
      );
    } finally {
      await host.connection
        .request("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    }
    const value = page.result?.value || {};
    const url = validBookmarkUrl(value.url);
    if (!url || !["http:", "https:"].some((protocol) => url.startsWith(protocol))) {
      throw new Error("bookmarks are available only for HTTP(S) tabs");
    }
    const document = await readBookmarkDocument(join(host.profileDir, "Default", "Bookmarks"));
    const existing = (await readStandaloneBookmarks(host.profileDir)).some(
      (bookmark) => bookmark.url === url,
    );
    const result = existing
      ? removeBookmark(document, url)
      : addBookmark(document, { url, name: value.name || url });
    if (existing ? result.removed > 0 : result.added) {
      await writeBookmarkDocument(host.profileDir, result.document);
    }
    return automationSuccess({
      bookmarked: !existing,
      bookmarks: await readStandaloneBookmarks(host.profileDir),
    });
  }
  return automationFailure("EGO_AUTOMATION_UNKNOWN_ACTION", request.action);
}

export function automationErrorResponse(error) {
  return automationFailure(
    error?.code || "EGO_AUTOMATION_FAILED",
    error?.message || String(error),
  );
}
