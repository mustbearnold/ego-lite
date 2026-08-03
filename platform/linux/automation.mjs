import { randomUUID } from "node:crypto";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const AUTOMATION_VERSION = 1;

const AUTOMATION_ACTIONS = new Set([
  "state",
  "application.get",
  "application.open",
  "application.print",
  "application.quit",
  "standard.print",
  "standard.count",
  "standard.exists",
  "standard.delete",
  "standard.duplicate",
  "standard.make",
  "standard.move",
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
  "window.set-name",
  "window.minimize",
  "window.restore",
  "window.maximize",
  "window.unmaximize",
  "bookmarks.list",
  "bookmark.folder.add",
  "bookmark.folder.rename",
  "bookmark.folder.remove",
  "bookmark.move",
  "bookmark.reorder",
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

function bookmarkText(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function standaloneBookmarkModel(document) {
  const bookmarks = [];
  const folders = [];
  const roots = [];

  function visitFolder(node, { id, parentId, index, path, depth }) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    const title = bookmarkText(node.name, id);
    const nextPath = [...path, title];
    const folder = {
      id,
      title,
      index,
      parentId,
      path: nextPath.join(" / "),
      folders: [],
      items: [],
    };
    folders.push({
      id: folder.id,
      title: folder.title,
      index: folder.index,
      parentId: folder.parentId,
      path: folder.path,
    });
    for (const [childIndex, child] of (node.children || []).entries()) {
      if (child?.type === "folder" || Array.isArray(child?.children)) {
        const nested = visitFolder(child, {
          id: bookmarkText(child.id, `${folder.id}/${childIndex + 1}`),
          parentId: folder.id,
          index: childIndex + 1,
          path: nextPath,
          depth: depth + 1,
        });
        if (nested) folder.folders.push(nested);
        continue;
      }
      if (child?.type !== "url") continue;
      const url = validBookmarkUrl(child.url);
      const titleValue = bookmarkText(child.name, "");
      if (!url || !titleValue || bookmarks.length >= 200) continue;
      const item = {
        id: bookmarkText(child.id, `${bookmarks.length + 1}`),
        title: titleValue.slice(0, 160),
        name: titleValue.slice(0, 160),
        url,
        index: childIndex + 1,
        folderId: folder.id,
        parentId: folder.id,
        folder: folder.path,
      };
      folder.items.push(item);
      bookmarks.push(item);
    }
    return folder;
  }

  for (const [rootIndex, [rootKey, root]] of Object.entries(
    document?.roots || {},
  ).entries()) {
    const folder = visitFolder(root, {
      id: bookmarkText(root.id, rootKey),
      parentId: null,
      index: rootIndex + 1,
      path: [],
      depth: 0,
    });
    if (folder) roots.push(folder);
  }
  return { bookmarks, folders, roots, bookmarkFolders: roots };
}

async function readBookmarkDocument(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readStandaloneBookmarkDocument(profileDir) {
  const storePath = join(profileDir, "ego-lite-bookmarks.json");
  const chromePath = join(profileDir, "Default", "Bookmarks");
  return (
    (await readBookmarkDocument(storePath)) ||
    (await readBookmarkDocument(chromePath)) ||
    { roots: {} }
  );
}

async function readStandaloneBookmarks(profileDir) {
  return parseBookmarkDocument(await readStandaloneBookmarkDocument(profileDir));
}

async function readStandaloneBookmarkModel(profileDir) {
  return standaloneBookmarkModel(await readStandaloneBookmarkDocument(profileDir));
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

function findStandaloneBookmarkFolder(document, folderId) {
  const requestedId = String(folderId || "");
  if (!requestedId) return null;
  function visit(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "folder" && String(node.id) === requestedId) return node;
    for (const child of node.children || []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }
  for (const root of Object.values(document?.roots || {})) {
    const found = visit(root);
    if (found) return found;
  }
  return null;
}

function findStandaloneBookmarkNode(document, nodeId) {
  const requestedId = String(nodeId || "");
  if (!requestedId) return null;
  function visit(node, parent = null, index = null) {
    if (!node || typeof node !== "object") return null;
    if (String(node.id || "") === requestedId) return { node, parent, index };
    for (const [childIndex, child] of (node.children || []).entries()) {
      const found = visit(child, node, childIndex);
      if (found) return found;
    }
    return null;
  }
  for (const root of Object.values(document?.roots || {})) {
    const found = visit(root);
    if (found) return found;
  }
  return null;
}

function containsStandaloneBookmarkNode(parent, candidate) {
  if (!parent || !candidate) return false;
  if (parent === candidate) return true;
  return (parent.children || []).some((child) =>
    containsStandaloneBookmarkNode(child, candidate),
  );
}

function moveBookmarkNode(document, { id, parentId = "1", index } = {}) {
  const next = ensureBookmarkBar(document);
  const source = findStandaloneBookmarkNode(next, id);
  const destination = findStandaloneBookmarkFolder(next, parentId || "1");
  if (
    !source ||
    !source.parent ||
    source.index === null ||
    !destination ||
    containsStandaloneBookmarkNode(source.node, destination)
  ) {
    return { document: next, moved: false };
  }
  destination.children ||= [];
  source.parent.children.splice(source.index, 1);
  const requestedIndex = Number(index);
  const oneBasedIndex = Number.isInteger(requestedIndex)
    ? requestedIndex
    : destination.children.length + 1;
  const insertionIndex = Math.max(
    0,
    Math.min(destination.children.length, oneBasedIndex - 1),
  );
  destination.children.splice(insertionIndex, 0, source.node);
  const model = standaloneBookmarkModel(next);
  return {
    document: next,
    moved: true,
    parentId: String(destination.id),
    index: insertionIndex + 1,
    bookmark:
      model.bookmarks.find((candidate) => candidate.id === String(id)) || null,
    folder: model.folders.find((candidate) => candidate.id === String(id)) || null,
  };
}

function duplicateBookmarkNode(document, { id } = {}) {
  const next = ensureBookmarkBar(document);
  const source = findStandaloneBookmarkNode(next, id);
  if (!source || !source.parent || source.index === null) {
    return { document: next, duplicated: false };
  }
  let nextId = Number(nextBookmarkId(next));
  const duplicate = JSON.parse(JSON.stringify(source.node));
  function refreshIds(node) {
    node.id = String(nextId++);
    if (node.guid) node.guid = randomUUID();
    for (const child of node.children || []) refreshIds(child);
  }
  refreshIds(duplicate);
  source.parent.children.splice(source.index + 1, 0, duplicate);
  const model = standaloneBookmarkModel(next);
  return {
    document: next,
    duplicated: true,
    parentId: String(source.parent.id),
    index: source.index + 2,
    bookmark:
      model.bookmarks.find((candidate) => candidate.id === String(duplicate.id)) ||
      null,
    folder:
      model.folders.find((candidate) => candidate.id === String(duplicate.id)) ||
      null,
  };
}

function addBookmark(document, { url, name, parentId = "1" }) {
  const canonical = validBookmarkUrl(url);
  const title = String(name || "").trim().slice(0, 160);
  if (!canonical || !title) return { document: clone(document), added: false };
  const next = ensureBookmarkBar(document);
  const existing = parseBookmarkDocument(next).find(
    (bookmark) => bookmark.url === canonical,
  );
  if (existing) return { document: next, added: false, bookmark: existing };
  const parent = findStandaloneBookmarkFolder(next, parentId || "1");
  if (!parent) return { document: next, added: false };
  const bookmark = {
    date_added: String((Date.now() + 11644473600000) * 1000),
    guid: randomUUID(),
    id: nextBookmarkId(next),
    name: title,
    type: "url",
    url: canonical,
  };
  parent.children ||= [];
  parent.children.push(bookmark);
  const modelBookmark = standaloneBookmarkModel(next).bookmarks.find(
    (candidate) => candidate.id === bookmark.id,
  );
  return {
    document: next,
    added: true,
    bookmark: modelBookmark || {
      id: bookmark.id,
      name: bookmark.name,
      url: bookmark.url,
      folder: "Bookmarks bar",
    },
  };
}

function removeBookmarkItem(document, { id, url } = {}) {
  const canonical = validBookmarkUrl(url);
  const requestedId = id === undefined || id === null ? null : String(id);
  const next = clone(document);
  let removed = 0;
  function visit(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      const matchesId = requestedId && String(child?.id || "") === requestedId;
      const matchesUrl =
        !requestedId && canonical && validBookmarkUrl(child.url) === canonical;
      if (child?.type === "url" && (matchesId || matchesUrl)) {
        removed += 1;
        return false;
      }
      visit(child);
      return true;
    });
  }
  if (canonical || requestedId) {
    for (const root of Object.values(next.roots || {})) visit(root);
  }
  return { document: next, removed };
}

function addBookmarkFolder(document, { title, parentId = "1" } = {}) {
  const name = String(title || "").trim().slice(0, 160);
  const next = ensureBookmarkBar(document);
  const parent = findStandaloneBookmarkFolder(next, parentId || "1");
  if (!name || !parent) return { document: next, added: false, folder: null };
  const folder = {
    children: [],
    date_added: String((Date.now() + 11644473600000) * 1000),
    date_modified: "0",
    guid: randomUUID(),
    id: nextBookmarkId(next),
    name,
    type: "folder",
  };
  parent.children ||= [];
  parent.children.push(folder);
  return {
    document: next,
    added: true,
    folder: standaloneBookmarkModel(next).folders.find(
      (candidate) => candidate.id === folder.id,
    ),
  };
}

function renameBookmarkFolder(document, { id, title } = {}) {
  const next = ensureBookmarkBar(document);
  const folder = findStandaloneBookmarkFolder(next, id);
  const name = String(title || "").trim().slice(0, 160);
  if (!folder || !name) return { document: next, renamed: false, folder: null };
  folder.name = name;
  return {
    document: next,
    renamed: true,
    folder: standaloneBookmarkModel(next).folders.find(
      (candidate) => candidate.id === String(id),
    ),
  };
}

function removeBookmarkFolder(document, folderId) {
  const requestedId = String(folderId || "");
  const next = clone(document);
  let removed = 0;
  function visit(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      if (child?.type === "folder" && String(child.id) === requestedId) {
        removed += 1;
        return false;
      }
      visit(child);
      return true;
    });
  }
  for (const root of Object.values(next.roots || {})) visit(root);
  return { document: next, removed };
}

async function writeBookmarkDocument(profileDir, document) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const paths = [
    join(profileDir, "ego-lite-bookmarks.json"),
    join(profileDir, "Default", "Bookmarks"),
  ];
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.automation.tmp`;
    await writeFile(temporaryPath, serialized);
    await rename(temporaryPath, path);
  }
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
  if (params.spaceId !== undefined) {
    const requestedSpaceId = await resolveStandaloneSpaceId(host, params.spaceId);
    await useStandaloneScope(host, requestedSpaceId);
    tabs = null;
  }
  const listedTabs = tabs || (await host.listTabs()).tabs || [];
  if (hasTabSpecifier(params)) {
    const match = listedTabs.find((tab, index) =>
      tabMatchesSpecifier(tab, params, index + 1),
    );
    if (!match) throw new Error("automation tab specifier did not match a tab");
    host.selectedTargetId = match.targetId;
    return match.targetId;
  }
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

function hasTabSpecifier(params = {}) {
  if (params.active === true) return false;
  const specifier = standardSpecifierValue(params);
  return [
    params.id,
    params.targetId,
    params.name,
    params.title,
    params.url,
    params.index,
    specifier,
  ].some((value) => value !== undefined && value !== null && String(value) !== "");
}

function tabMatchesSpecifier(tab, params = {}, index) {
  const id = params.id ?? params.targetId;
  if (id !== undefined && id !== null && String(id) !== "") {
    return String(tab.targetId ?? tab.id ?? "") === String(id);
  }
  return standardMatches({ ...tab, index }, params);
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

function standaloneApplicationState(host) {
  return {
    name: host.isElectron ? "ego lite" : "Chromium",
    frontmost: !Boolean(process.env.EGO_LITE_HEADLESS),
    version: host.browserVersion || (host.isElectron ? "ego lite" : "Chromium"),
  };
}

const MAX_MOVED_HISTORY_ENTRIES = 50;

function standaloneNavigationUrl(value) {
  const text = String(value || "").trim();
  if (text.startsWith("view-source:")) {
    return standaloneNavigationUrl(text.slice("view-source:".length))
      ? text
      : null;
  }
  try {
    const url = new URL(text || "about:blank");
    return ["about:", "file:", "http:", "https:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const CAPTURE_MOVED_INTERACTION_SCRIPT = `(() => {
  const selectorFor = (element) => {
    if (element.id) return { type: "id", value: element.id };
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (current === document.body) {
        parts.unshift("body");
        break;
      }
      const tag = current.localName;
      let ordinal = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === tag) ordinal += 1;
      }
      parts.unshift(tag + ":nth-of-type(" + ordinal + ")");
      current = current.parentElement;
    }
    return { type: "css", value: parts.join(">").slice(0, 500) };
  };
  const fields = Array.from(
    document.querySelectorAll("input, textarea, select, [contenteditable=\\"true\\"]"),
  )
    .slice(0, 100)
    .map((element) => {
      const kind = element.localName;
      const inputType = kind === "input" ? String(element.type || "text").toLowerCase() : kind;
      if (inputType === "password" || inputType === "file") return null;
      const result = { selector: selectorFor(element), kind, inputType };
      if (kind === "input" && ["checkbox", "radio"].includes(inputType)) {
        result.checked = Boolean(element.checked);
      } else if (kind === "select") {
        result.value = String(element.value || "").slice(0, 4000);
        result.selectedIndex = Number(element.selectedIndex);
      } else if (element.isContentEditable) {
        result.text = String(element.textContent || "").slice(0, 4000);
      } else {
        result.value = String(element.value || "").slice(0, 4000);
      }
      return result;
    })
    .filter(Boolean);
  const active = document.activeElement;
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    fields,
    active: active && active !== document.body ? selectorFor(active) : null,
  };
})()`;

function normalizeStandaloneNavigationHistory(value) {
  if (!value || !Array.isArray(value.entries)) return null;
  const entries = [];
  let activeIndex = 0;
  for (const [rawIndex, entry] of value.entries.entries()) {
    const url = standaloneNavigationUrl(entry?.url);
    if (!url || entries.length >= MAX_MOVED_HISTORY_ENTRIES) continue;
    entries.push({
      url,
      title: String(entry.title || ""),
      ...(entry.userTypedURL ? { userTypedURL: String(entry.userTypedURL) } : {}),
      ...(entry.transitionType ? { transitionType: String(entry.transitionType) } : {}),
    });
    if (rawIndex <= Number(value.currentIndex)) activeIndex = entries.length - 1;
  }
  return entries.length > 0
    ? {
        entries,
        index: Math.max(0, Math.min(activeIndex, entries.length - 1)),
      }
    : null;
}

async function captureStandaloneMovedState(host, targetId) {
  const { sessionId } = await targetSession(host, targetId);
  try {
    const history = normalizeStandaloneNavigationHistory(
      await host.connection
        .request("Page.getNavigationHistory", {}, sessionId)
        .catch(() => null),
    );
    const interaction = await host.connection
      .request(
        "Runtime.evaluate",
        {
          expression: CAPTURE_MOVED_INTERACTION_SCRIPT,
          returnByValue: true,
        },
        sessionId,
      )
      .then(runtimeValue)
      .catch(() => null);
    return { history, interaction };
  } finally {
    await host.connection
      .request("Target.detachFromTarget", { sessionId })
      .catch(() => {});
  }
}

async function waitForStandalonePage(host, sessionId, expectedUrl = null) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const page = runtimeValue(
        await host.connection.request(
          "Runtime.evaluate",
          {
            expression: "({ href: location.href, readyState: document.readyState })",
            returnByValue: true,
          },
          sessionId,
        ),
      );
      if (
        page?.readyState === "complete" &&
        (!expectedUrl || page.href === expectedUrl)
      ) {
        return true;
      }
    } catch {
      // The renderer can briefly reject evaluation between navigations.
    }
    await delay(25);
  }
  return false;
}

function restoreMovedInteractionScript(interaction) {
  return `(() => {
    const state = ${JSON.stringify(interaction || {})};
    const find = (descriptor) => {
      if (!descriptor) return null;
      try {
        return descriptor.type === "id"
          ? document.getElementById(descriptor.value)
          : document.querySelector(descriptor.value);
      } catch {
        return null;
      }
    };
    let restored = 0;
    for (const field of Array.isArray(state.fields) ? state.fields : []) {
      const element = find(field.selector);
      if (!element) continue;
      if (field.kind === "input" && ["checkbox", "radio"].includes(field.inputType)) {
        element.checked = Boolean(field.checked);
      } else if (field.kind === "select") {
        element.value = String(field.value || "");
        if (Number.isInteger(field.selectedIndex) && element.selectedIndex < 0) {
          element.selectedIndex = field.selectedIndex;
        }
      } else if (element.isContentEditable) {
        element.textContent = String(field.text || "");
      } else if ("value" in element) {
        element.value = String(field.value || "");
      }
      restored += 1;
    }
    window.scrollTo(Number(state.scrollX) || 0, Number(state.scrollY) || 0);
    const active = find(state.active);
    if (active && typeof active.focus === "function") active.focus();
    return { restored, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
  })()`;
}

async function restoreStandaloneMovedState(host, targetId, preserved) {
  const { sessionId } = await targetSession(host, targetId);
  const result = {
    history: { status: "unavailable", entries: 0 },
    interaction: { status: "unavailable", fields: 0 },
  };
  try {
    const preservedHistory = preserved?.history;
    if (preservedHistory?.entries?.length) {
      try {
        await host.connection.request("Page.resetNavigationHistory", {}, sessionId);
        for (const entry of preservedHistory.entries) {
          await host.connection.request("Page.navigate", { url: entry.url }, sessionId);
          if (!(await waitForStandalonePage(host, sessionId, entry.url))) {
            throw new Error(`moved history entry did not finish loading: ${entry.url}`);
          }
        }
        const destinationHistory = await host.connection.request(
          "Page.getNavigationHistory",
          {},
          sessionId,
        );
        const destinationEntry =
          destinationHistory.entries?.[preservedHistory.index] ||
          destinationHistory.entries?.at(-1);
        if (destinationEntry?.id !== undefined && preservedHistory.index < destinationHistory.entries.length) {
          await host.connection.request(
            "Page.navigateToHistoryEntry",
            { entryId: destinationEntry.id },
            sessionId,
          );
          if (!(await waitForStandalonePage(host, sessionId, destinationEntry.url))) {
            throw new Error(`moved active history entry did not finish loading: ${destinationEntry.url}`);
          }
        }
        result.history = {
          status: "restored",
          entries: preservedHistory.entries.length,
          index: preservedHistory.index,
        };
      } catch (error) {
        result.history = {
          status: "failed",
          entries: preservedHistory.entries.length,
          message: error?.message || String(error),
        };
      }
    }
    if (preserved?.interaction) {
      await waitForStandalonePage(host, sessionId);
      const restored = runtimeValue(
        await host.connection.request(
          "Runtime.evaluate",
          {
            expression: restoreMovedInteractionScript(preserved.interaction),
            returnByValue: true,
          },
          sessionId,
        ),
      );
      result.interaction = {
        status: "restored",
        fields: Number(restored?.restored) || 0,
        scrollX: Number(restored?.scrollX) || 0,
        scrollY: Number(restored?.scrollY) || 0,
      };
    }
  } finally {
    await host.connection
      .request("Target.detachFromTarget", { sessionId })
      .catch(() => {});
  }
  return result;
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
  const bookmarkModel = await readStandaloneBookmarkModel(host.profileDir);
  const tabs = listedTabs.map((tab, index) => ({
    ...tab,
    id: tab.targetId,
    index: index + 1,
    spaceId: host.currentSpace()?.id ?? null,
    spaceName: host.currentSpace()?.name || null,
    active: tab.targetId === activeTabId,
  }));
  const activeTab = tabs.find((tab) => tab.active) || null;
  const activeTabIndex = activeTab
    ? tabs.findIndex((tab) => tab.id === activeTab.id) + 1
    : null;
  const windowTitle = host.isElectron ? "ego lite" : "Chromium";
  return {
    platform: "linux",
    profileId: host.profileId || "default",
    serverName: host.serverName || "default",
    application: standaloneApplicationState(host),
    window: {
      id: "main",
      name: windowTitle,
      title: windowTitle,
      givenName: "",
      index: 1,
      active: true,
      visible: !Boolean(process.env.EGO_LITE_HEADLESS),
      minimized: false,
      maximized: false,
      zoomed: false,
      fullscreen: false,
      bounds: null,
      closeable: null,
      minimizable: null,
      resizable: null,
      zoomable: null,
      activeTab,
      activeTabIndex,
      mode: activeTab?.private ? "incognito" : "normal",
    },
    scope: host.currentSpace()?.id ?? null,
    activeTabId,
    tabs,
    taskSpaces: spaces,
    bookmarks: bookmarkModel.bookmarks.map(
      ({ id, name, url, folder }) => ({ id, name, url, folder }),
    ),
    bookmarkItems: bookmarkModel.bookmarks,
    bookmarkFolders: bookmarkModel.bookmarkFolders,
    capabilities: {
      windowActions: false,
      tabActions: true,
      bookmarkActions: true,
      fullWindowInventory: false,
    },
  };
}

function flattenStandaloneBookmarkFolders(folders, result = []) {
  for (const folder of folders || []) {
    result.push(folder);
    flattenStandaloneBookmarkFolders(folder.folders, result);
  }
  return result;
}

function standardKind(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (["application", "window", "windows"].includes(normalized)) return "windows";
  if (["tab", "tabs"].includes(normalized)) return "tabs";
  if (["space", "spaces", "taskspace", "taskspaces"].includes(normalized)) {
    return "spaces";
  }
  if (["bookmark", "bookmarks", "bookmarkitem", "bookmarkitems", "item", "items"].includes(normalized)) {
    return "bookmarkItems";
  }
  if (["folder", "folders", "bookmarkfolder", "bookmarkfolders"].includes(normalized)) {
    return "bookmarkFolders";
  }
  throw new Error(`unsupported standard object kind: ${String(value || "")}`);
}

function standardKindFromParams(params = {}, fallback) {
  return standardKind(
    params.kind ??
      params.type ??
      params.objectClass ??
      params.each ??
      params.new ??
      fallback,
  );
}

function standardSpecifierValue(params = {}) {
  return params.specifier ?? params.object ?? params.targetObject;
}

function standardSpecifierFields(params = {}) {
  const value = standardSpecifierValue(params);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return params;
  }
  return { ...value, ...params };
}

function standardCandidates(state, kindValue) {
  const kind = standardKind(kindValue);
  const candidates = (() => {
    switch (kind) {
    case "windows":
      return [{ ...state.window }];
    case "tabs":
      return state.tabs || [];
    case "spaces":
      return state.taskSpaces || [];
    case "bookmarkItems":
      return state.bookmarkItems || [];
    case "bookmarkFolders":
      return flattenStandaloneBookmarkFolders(state.bookmarkFolders);
    default:
      return [];
    }
  })();
  return candidates.map((candidate, index) =>
    candidate.index === undefined && kind !== "bookmarkItems" && kind !== "bookmarkFolders"
      ? { ...candidate, index: index + 1 }
      : candidate,
  );
}

function standardMatches(candidate, params = {}) {
  if (params.active === true && !candidate.active) return false;
  const specifier = standardSpecifierValue(params);
  if (
    specifier !== undefined &&
    (specifier === null || typeof specifier !== "object" || Array.isArray(specifier))
  ) {
    if (typeof specifier === "number") {
      if (candidate.index !== Number(specifier)) return false;
    } else {
      const text = String(specifier);
      const candidateIds = [candidate.id, candidate.targetId, candidate.taskId]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value));
      const candidateName = candidate.name ?? candidate.title ?? "";
      if (
        !candidateIds.includes(text) &&
        String(candidateName) !== text &&
        String(candidate.url || "") !== text &&
        String(candidate.path || "") !== text
      ) {
        return false;
      }
    }
  }
  const fields = standardSpecifierFields(params);
  const id = fields.id ?? fields.targetId ?? fields.taskId;
  const name = fields.name ?? fields.title;
  if (id !== undefined && id !== null && String(id) !== "") {
    const candidateIds = [candidate.id, candidate.targetId, candidate.taskId]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value));
    if (!candidateIds.includes(String(id))) return false;
  }
  if (fields.url !== undefined && String(candidate.url || "") !== String(fields.url)) {
    return false;
  }
  if (
    fields.folder !== undefined &&
    String(candidate.folder || "").toLowerCase() !== String(fields.folder).toLowerCase()
  ) {
    return false;
  }
  if (
    fields.folderId !== undefined &&
    String(candidate.folderId ?? candidate.parentId ?? "") !== String(fields.folderId)
  ) {
    return false;
  }
  if (name !== undefined) {
    const candidateName = candidate.name ?? candidate.title ?? "";
    if (String(candidateName) !== String(name)) return false;
  }
  if (fields.path !== undefined && candidate.path !== undefined) {
    const path = Array.isArray(fields.path)
      ? fields.path.join(" / ")
      : String(fields.path);
    if (String(candidate.path || "") !== path) return false;
  }
  if (fields.index !== undefined) {
    const index = Number(fields.index);
    if (!Number.isInteger(index) || candidate.index !== index) return false;
  }
  return true;
}

function standardFind(state, params = {}) {
  const candidates = standardCandidates(state, params.kind ?? params.type);
  return candidates.find((candidate) => standardMatches(candidate, params)) || null;
}

function destinationSpaceValue(params = {}) {
  if (params.destinationSpaceId !== undefined) return params.destinationSpaceId;
  if (params.spaceId !== undefined) return params.spaceId;
  if (params.destinationSpace !== undefined) return params.destinationSpace;
  if (params.space !== undefined) return params.space;
  if (params.destination !== undefined) return params.destination;
  if (params.to !== undefined) return params.to;
  return undefined;
}

function bookmarkDestinationValue(params = {}) {
  for (const key of [
    "parentId",
    "folderId",
    "destinationFolderId",
    "destinationFolder",
    "parent",
    "at",
    "to",
  ]) {
    if (params[key] !== undefined) return params[key];
  }
  return "1";
}

function bookmarkMoveDestinationValue(params = {}) {
  for (const key of [
    "parentId",
    "destinationFolderId",
    "destinationFolder",
    "parent",
    "to",
  ]) {
    if (params[key] !== undefined) return params[key];
  }
  return "1";
}

function bookmarkFolderSelectorParams(params = {}) {
  const specifier =
    params.folderSpecifier ?? params.folder ?? params.specifier ?? params.object;
  if (specifier !== undefined) return { specifier };
  const id = params.id ?? params.folderId;
  return id === undefined ? {} : { id };
}

function resolveStandaloneBookmarkFolderId(state, value = "1") {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? value.specifier ?? value.object ?? value
      : value;
  if (raw === null || raw === undefined || raw === "") return "1";
  const folders = flattenStandaloneBookmarkFolders(state.bookmarkFolders);
  const fields =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = raw && typeof raw !== "object" ? String(raw).trim() : "";
  const requestedId = fields.id ?? fields.folderId ?? fields.targetId;
  if (requestedId !== undefined && requestedId !== null) {
    if (String(requestedId) === "1") return "1";
    const match = folders.find((folder) => String(folder.id) === String(requestedId));
    if (match) return String(match.id);
  }
  const requestedPath = fields.path ?? fields.folderPath;
  if (requestedPath !== undefined) {
    const path = Array.isArray(requestedPath)
      ? requestedPath.join(" / ")
      : String(requestedPath).trim();
    const match = folders.find((folder) => String(folder.path || "") === path);
    if (match) return String(match.id);
  }
  const requestedTitle = fields.title ?? fields.name;
  const requestedIndex = fields.index;
  const parentValue = fields.parentId ?? fields.parent;
  const parentId =
    parentValue === undefined
      ? null
      : resolveStandaloneBookmarkFolderId(state, parentValue);
  if (requestedTitle !== undefined || requestedIndex !== undefined) {
    const match = folders.find(
      (folder) =>
        (parentId === null || String(folder.parentId) === String(parentId)) &&
        (requestedTitle === undefined ||
          String(folder.title || "") === String(requestedTitle)) &&
        (requestedIndex === undefined || Number(folder.index) === Number(requestedIndex)),
    );
    if (match) return String(match.id);
  }
  if (text) {
    if (text === "1" || text.toLowerCase() === "bookmarks bar") return "1";
    const byId = folders.find((folder) => String(folder.id) === text);
    if (byId) return String(byId.id);
    const byPath = folders.find((folder) => String(folder.path || "") === text);
    if (byPath) return String(byPath.id);
    const byTitle = folders.find((folder) => String(folder.title || "") === text);
    if (byTitle) return String(byTitle.id);
    const byIndex = folders.find((folder) => Number(folder.index) === Number(text));
    if (byIndex) return String(byIndex.id);
  }
  throw new Error(`bookmark folder not found: ${text || JSON.stringify(raw)}`);
}

function standardBookmarkSource(state, params, kind) {
  const selector = { ...params };
  delete selector.index;
  if (params.sourceIndex !== undefined) selector.index = params.sourceIndex;
  if (
    selector.id === undefined &&
    selector.targetId === undefined &&
    standardSpecifierValue(selector) === undefined
  ) {
    const alias = selector.bookmarkId ?? selector.folderId;
    if (alias !== undefined) selector.id = alias;
  }
  const requestedKind = selector.kind ?? selector.type;
  if (requestedKind !== undefined) {
    return standardFind(state, { ...selector, kind: requestedKind });
  }
  return (
    standardFind(state, { ...selector, kind }) ||
    standardFind(state, {
      ...selector,
      kind: kind === "bookmarkItems" ? "bookmarkFolders" : "bookmarkItems",
    })
  );
}

async function resolveStandaloneSpaceId(host, value) {
  if (value === null) return null;
  if (value === undefined) {
    throw new Error("standard.move tab requires a destination Space");
  }
  const valueObject =
    value && typeof value === "object" && !Array.isArray(value)
      ? value.specifier ?? value.object ?? value
      : value;
  const raw =
    valueObject && typeof valueObject === "object" && !Array.isArray(valueObject)
      ? valueObject.id ?? valueObject.taskId ?? valueObject.name ?? valueObject.title
      : valueObject;
  const text = String(raw ?? "").trim();
  if (["", "primary", "window", "application"].includes(text.toLowerCase())) {
    return null;
  }
  const spaces = (await host.listTaskSpaces()).taskSpaces || [];
  const numeric = Number(text);
  const match = spaces.find(
    (space) =>
      (Number.isInteger(numeric) && Number(space.id) === numeric) ||
      String(space.taskId || "") === text ||
      String(space.name || "") === text,
  );
  if (!match) throw new Error(`task Space not found: ${text}`);
  return Number(match.id);
}

async function useStandaloneScope(host, spaceId) {
  if (spaceId === null) return host.usePrimaryScope();
  return host.useTaskSpace(spaceId);
}

async function createStandaloneMovedTab(host, spaceId, url, preserved = null) {
  await useStandaloneScope(host, spaceId);
  const before = (await host.listTabs()).tabs || [];
  const blank =
    before.length === 1 &&
    ["about:blank", "chrome://newtab/"].includes(before[0].url);
  const tab = await host.createTab(url || "about:blank");
  if (blank && blank.targetId !== tab.targetId) {
    await host
      .closeTarget(blank.targetId, {
        preserveSpace: true,
        suppressReopen: true,
      })
      .catch(() => {});
  }
  const preservation = preserved
    ? await restoreStandaloneMovedState(host, tab.targetId, preserved)
    : {
        history: { status: "unavailable", entries: 0 },
        interaction: { status: "unavailable", fields: 0 },
      };
  return { tab, preservation };
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
  if (request.action === "application.get") {
    return automationSuccess({
      application: standaloneApplicationState(host),
      state: await standaloneState(host),
    });
  }
  if (request.action === "application.open") {
    const requestedUrl = request.params.url ?? request.params.target;
    if (!requestedUrl) throw new Error("application.open requires params.url");
    if (request.params.spaceId !== undefined && request.params.spaceId !== null) {
      await host.useTaskSpace(Number(request.params.spaceId));
    }
    const tab = await host.createTab(requestedUrl);
    await setAutomationSelection(host, tab.targetId);
    return automationSuccess({ opened: true, tab, state: await standaloneState(host) });
  }
  if (request.action === "application.print") {
    return automationSuccess(
      await standaloneTabCommand(host, { ...request, action: "tab.print" }),
    );
  }
  if (request.action === "standard.print") {
    const params = request.params;
    const kind = standardKindFromParams(params, "tabs");
    if (kind !== "tabs" && kind !== "windows") {
      throw new Error(`standard.print does not support ${kind}`);
    }
    if (params.spaceId !== undefined) {
      await useStandaloneScope(host, await resolveStandaloneSpaceId(host, params.spaceId));
    }
    const state = await standaloneState(host);
    if (kind === "windows" && !standardFind(state, { ...params, kind })) {
      throw new Error("standard.print window not found");
    }
    const commandParams = { ...params };
    if (kind === "windows") {
      for (const key of [
        "id",
        "targetId",
        "name",
        "title",
        "url",
        "index",
        "specifier",
        "object",
        "targetObject",
      ]) {
        delete commandParams[key];
      }
    }
    return automationSuccess({
      ...(await standaloneTabCommand(host, {
        ...request,
        action: "tab.print",
        params: commandParams,
      })),
      kind,
    });
  }
  if (request.action === "application.quit") {
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED",
      "application.quit is only available in the Electron desktop host",
    );
  }
  if (request.action === "standard.count") {
    const state = await standaloneState(host);
    const kind = standardKindFromParams(request.params);
    return automationSuccess({ kind, count: standardCandidates(state, kind).length });
  }
  if (request.action === "standard.exists") {
    const state = await standaloneState(host);
    const kind = standardKindFromParams(request.params);
    const object = standardFind(state, { ...request.params, kind });
    return automationSuccess({ kind, exists: Boolean(object), object });
  }
  if (request.action === "standard.delete") {
    const state = await standaloneState(host);
    const kind = standardKindFromParams(request.params);
    if (kind === "tabs") {
      const id = await selectAutomationTarget(host, request.params);
      await host.closeTarget(id);
      const remaining = (await host.listTabs()).tabs || [];
      await setAutomationSelection(
        host,
        remaining.find((tab) => tab.targetId !== id)?.targetId || null,
      );
      return automationSuccess({ deleted: true, kind, state: await standaloneState(host) });
    }
    if (kind === "bookmarkItems") {
      const item = standardFind(state, { ...request.params, kind });
      if (!item) throw new Error("standard.delete bookmark item not found");
      const result = removeBookmarkItem(
        await readStandaloneBookmarkDocument(host.profileDir),
        { id: item.id, url: item.url },
      );
      if (!result.removed) throw new Error("standard.delete bookmark item failed");
      await writeBookmarkDocument(host.profileDir, result.document);
      return automationSuccess({
        deleted: true,
        kind,
        state: await standaloneState(host),
      });
    }
    if (kind === "bookmarkFolders") {
      const folder = standardFind(state, { ...request.params, kind });
      if (!folder) throw new Error("standard.delete bookmark folder not found");
      const result = removeBookmarkFolder(
        await readStandaloneBookmarkDocument(host.profileDir),
        folder.id,
      );
      if (!result.removed) throw new Error("standard.delete bookmark folder failed");
      await writeBookmarkDocument(host.profileDir, result.document);
      return automationSuccess({
        deleted: true,
        kind,
        state: await standaloneState(host),
      });
    }
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED",
      `standard.delete does not support ${kind} in standalone Chromium`,
    );
  }
  if (request.action === "standard.duplicate") {
    const state = await standaloneState(host);
    const kind = standardKindFromParams(request.params);
    if (kind === "tabs") {
      const id = await selectAutomationTarget(host, request.params);
      const listed = (await host.listTabs()).tabs || [];
      const source = listed.find((tab) => tab.targetId === id);
      if (!source) throw new Error("standard.duplicate tab not found");
      if (source.spaceId !== null && source.spaceId !== undefined) {
        await host.useTaskSpace(Number(source.spaceId));
      }
      const tab = await host.createTab(source.url || "about:blank");
      await setAutomationSelection(host, tab.targetId);
      return automationSuccess({
        duplicated: true,
        kind,
        tab,
        state: await standaloneState(host),
      });
    }
    if (kind === "bookmarkItems" || kind === "bookmarkFolders") {
      const object = standardFind(state, { ...request.params, kind });
      if (!object) throw new Error("standard.duplicate bookmark object not found");
      const result = duplicateBookmarkNode(
        await readStandaloneBookmarkDocument(host.profileDir),
        { id: object.id },
      );
      if (!result.duplicated) throw new Error("standard.duplicate bookmark object failed");
      await writeBookmarkDocument(host.profileDir, result.document);
      return automationSuccess({
        duplicated: true,
        kind,
        bookmark: result.bookmark,
        folder: result.folder,
        state: await standaloneState(host),
      });
    }
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED",
      `standard.duplicate does not support ${kind} in standalone Chromium`,
    );
  }
  if (request.action === "standard.make") {
    const state = await standaloneState(host);
    const kind = standardKindFromParams(request.params);
    if (kind === "tabs") {
      if (request.params.spaceId !== undefined && request.params.spaceId !== null) {
        await host.useTaskSpace(Number(request.params.spaceId));
      }
      const tab = await host.createTab(request.params.url || "about:blank");
      await setAutomationSelection(host, tab.targetId);
      return automationSuccess({
        made: true,
        kind,
        tab,
        state: await standaloneState(host),
      });
    }
    if (kind === "bookmarkFolders") {
      const properties = request.params.withProperties ?? request.params.properties ?? {};
      const result = addBookmarkFolder(
        await readStandaloneBookmarkDocument(host.profileDir),
        {
          title:
            request.params.title ??
            request.params.name ??
            properties.title ??
            properties.name,
          parentId: resolveStandaloneBookmarkFolderId(
            state,
            bookmarkDestinationValue(request.params),
          ),
        },
      );
      if (!result.added) throw new Error("standard.make bookmark folder failed");
      await writeBookmarkDocument(host.profileDir, result.document);
      return automationSuccess({
        made: true,
        kind,
        folder: result.folder,
        state: await standaloneState(host),
      });
    }
    if (kind === "bookmarkItems") {
      const properties = request.params.withProperties ?? request.params.properties ?? {};
      const result = addBookmark(
        await readStandaloneBookmarkDocument(host.profileDir),
        {
          url: request.params.url ?? properties.url ?? properties.URL,
          name:
            request.params.name ??
            request.params.title ??
            properties.name ??
            properties.title,
          parentId: resolveStandaloneBookmarkFolderId(
            state,
            bookmarkDestinationValue(request.params),
          ),
        },
      );
      if (!result.added) throw new Error("standard.make bookmark item failed");
      await writeBookmarkDocument(host.profileDir, result.document);
      return automationSuccess({
        made: true,
        kind,
        bookmark: result.bookmark,
        state: await standaloneState(host),
      });
    }
    return automationFailure(
      "EGO_AUTOMATION_UNSUPPORTED",
      `standard.make does not support ${kind} in standalone Chromium`,
    );
  }
  if (request.action === "standard.move") {
    const kind = standardKindFromParams(request.params, "bookmarkItems");
    let state;
    if (kind === "tabs") {
      if (request.params.sourceSpaceId !== undefined) {
        const sourceSpaceId = await resolveStandaloneSpaceId(
          host,
          request.params.sourceSpaceId,
        );
        await useStandaloneScope(host, sourceSpaceId);
      }
      state = await standaloneState(host);
      const sourceParams = { ...request.params, kind };
      delete sourceParams.index;
      if (request.params.sourceIndex !== undefined) {
        sourceParams.index = request.params.sourceIndex;
      }
      const source = standardFind(state, sourceParams);
      if (!source) throw new Error("standard.move tab not found");
      const sourceSpaceId = state.scope;
      const destinationSpaceId = await resolveStandaloneSpaceId(
        host,
        destinationSpaceValue(request.params),
      );
      if (sourceSpaceId === destinationSpaceId) {
        return automationSuccess({
          moved: true,
          changed: false,
          kind,
          tab: source,
          state,
        });
      }
      if (source.private && destinationSpaceId !== null) {
        throw new Error("private tabs cannot move into an Agent Space");
      }
      const preserved = await captureStandaloneMovedState(host, source.targetId).catch(
        () => null,
      );
      const moved = await createStandaloneMovedTab(
        host,
        destinationSpaceId,
        source.url || "about:blank",
        preserved,
      );
      const movedTab = moved.tab;
      if (sourceSpaceId === null && destinationSpaceId !== null) {
        await useStandaloneScope(host, null);
        await host.createTab("about:blank");
      }
      await useStandaloneScope(host, sourceSpaceId);
      await host.closeTarget(source.targetId, {
        preserveSpace: true,
        suppressReopen: true,
      });
      await useStandaloneScope(host, destinationSpaceId);
      await host.activateTarget(movedTab.targetId);
      await setAutomationSelection(host, movedTab.targetId);
      const finalState = await standaloneState(host);
      return automationSuccess({
        moved: true,
        kind,
        fromSpaceId: sourceSpaceId,
        spaceId: destinationSpaceId,
        preservation: moved.preservation,
        tab:
          finalState.tabs.find((tab) => tab.targetId === movedTab.targetId) ||
          finalState.tabs.find((tab) => tab.id === movedTab.targetId) ||
          movedTab,
        state: finalState,
      });
    }
    if (kind !== "bookmarkItems" && kind !== "bookmarkFolders") {
      return automationFailure(
        "EGO_AUTOMATION_UNSUPPORTED",
        `standard.move does not support ${kind} in standalone Chromium`,
      );
    }
    state = await standaloneState(host);
    const source = standardBookmarkSource(state, request.params, kind);
    if (!source) throw new Error("standard.move bookmark object not found");
    const result = moveBookmarkNode(
      await readStandaloneBookmarkDocument(host.profileDir),
      {
        id: source.id,
        parentId: resolveStandaloneBookmarkFolderId(
          state,
          bookmarkMoveDestinationValue(request.params),
        ),
        index: request.params.index,
      },
    );
    if (!result.moved) throw new Error("standard.move bookmark object failed");
    await writeBookmarkDocument(host.profileDir, result.document);
    return automationSuccess({
      moved: true,
      kind,
      parentId: result.parentId,
      index: result.index,
      bookmark: result.bookmark,
      folder: result.folder,
      state: await standaloneState(host),
    });
  }
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
  if (
    [
      "window.focus",
      "window.fullscreen",
      "window.set-name",
      "window.minimize",
      "window.restore",
      "window.maximize",
      "window.unmaximize",
    ].includes(request.action)
  ) {
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
    const state = await standaloneState(host);
    return automationSuccess({
      bookmarks: state.bookmarks,
      bookmarkItems: state.bookmarkItems,
      bookmarkFolders: state.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.folder.add") {
    const title = String(request.params.title ?? request.params.name ?? "").trim();
    if (!title) throw new Error("bookmark.folder.add requires params.title");
    const state = await standaloneState(host);
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = addBookmarkFolder(document, {
      title,
      parentId: resolveStandaloneBookmarkFolderId(
        state,
        bookmarkDestinationValue(request.params),
      ),
    });
    if (!result.added) throw new Error("bookmark folder parent not found");
    await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      added: true,
      folder: result.folder,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.folder.rename") {
    const title = String(request.params.title ?? request.params.name ?? "").trim();
    if (!title) {
      throw new Error(
        "bookmark.folder.rename requires params.id and params.title",
      );
    }
    const state = await standaloneState(host);
    const folder = standardFind(state, {
      ...bookmarkFolderSelectorParams(request.params),
      kind: "bookmarkFolders",
    });
    if (!folder) throw new Error("bookmark folder not found");
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = renameBookmarkFolder(document, { id: folder.id, title });
    if (!result.renamed) throw new Error("bookmark folder not found");
    await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      renamed: true,
      folder: result.folder,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.folder.remove") {
    const state = await standaloneState(host);
    const folder = standardFind(state, {
      ...bookmarkFolderSelectorParams(request.params),
      kind: "bookmarkFolders",
    });
    if (!folder) {
      throw new Error("bookmark.folder.remove requires params.id");
    }
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = removeBookmarkFolder(document, folder.id);
    if (!result.removed) throw new Error("bookmark folder not found");
    await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      removed: result.removed,
      bookmarks: nextState.bookmarks,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.move" || request.action === "bookmark.reorder") {
    const state = await standaloneState(host);
    const source = standardBookmarkSource(state, request.params, "bookmarkItems");
    if (!source) {
      throw new Error(`${request.action} requires params.id`);
    }
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = moveBookmarkNode(document, {
      id: source.id,
      parentId: resolveStandaloneBookmarkFolderId(
        state,
        bookmarkMoveDestinationValue(request.params),
      ),
      index: request.params.index,
    });
    if (!result.moved) throw new Error("bookmark node cannot be moved");
    await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      moved: true,
      parentId: result.parentId,
      index: result.index,
      bookmark: result.bookmark,
      folder: result.folder,
      bookmarkItems: nextState.bookmarkItems,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.add") {
    const state = await standaloneState(host);
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = addBookmark(document, {
      ...request.params,
      parentId: resolveStandaloneBookmarkFolderId(
        state,
        bookmarkDestinationValue(request.params),
      ),
    });
    if (result.added) await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      added: result.added,
      bookmark: result.bookmark || null,
      bookmarks: nextState.bookmarks,
      bookmarkItems: nextState.bookmarkItems,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.remove") {
    const state = await standaloneState(host);
    const selected = standardFind(state, {
      ...request.params,
      kind: "bookmarkItems",
    });
    const url = request.params.url || selected?.url;
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const result = removeBookmarkItem(document, {
      id: selected?.id,
      url,
    });
    if (result.removed) await writeBookmarkDocument(host.profileDir, result.document);
    const nextState = await standaloneState(host);
    return automationSuccess({
      removed: result.removed,
      bookmarks: nextState.bookmarks,
      bookmarkItems: nextState.bookmarkItems,
      bookmarkFolders: nextState.bookmarkFolders,
    });
  }
  if (request.action === "bookmark.open") {
    const state = await standaloneState(host);
    const bookmark = standardFind(state, {
      ...request.params,
      kind: "bookmarkItems",
    });
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
    const document = await readStandaloneBookmarkDocument(host.profileDir);
    const existing = (await readStandaloneBookmarks(host.profileDir)).some(
      (bookmark) => bookmark.url === url,
    );
    const result = existing
      ? removeBookmarkItem(document, { url })
      : addBookmark(document, { url, name: value.name || url });
    if (existing ? result.removed > 0 : result.added) {
      await writeBookmarkDocument(host.profileDir, result.document);
    }
    const state = await standaloneState(host);
    return automationSuccess({ bookmarked: !existing, state });
  }
  return automationFailure("EGO_AUTOMATION_UNKNOWN_ACTION", request.action);
}

export function automationErrorResponse(error) {
  return automationFailure(
    error?.code || "EGO_AUTOMATION_FAILED",
    error?.message || String(error),
  );
}
