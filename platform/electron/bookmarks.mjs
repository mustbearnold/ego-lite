import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const MAX_BOOKMARKS = 200;
const MAX_DEPTH = 6;
const ALLOWED_PROTOCOLS = new Set(["file:", "http:", "https:"]);

function bookmarkUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function visit(node, folder, bookmarks) {
  if (!node || bookmarks.length >= MAX_BOOKMARKS) return;
  if (node.type === "url") {
    const url = bookmarkUrl(node.url);
    const name = String(node.name || "").trim();
    if (url && name) {
      bookmarks.push({
        id: String(node.id || `${bookmarks.length + 1}`),
        name: name.slice(0, 160),
        url,
        folder: folder.join(" / "),
      });
    }
    return;
  }
  if (node.type !== "folder" && !Array.isArray(node.children)) return;
  if (!Array.isArray(node.children)) return;
  const nextFolder = node.name ? [...folder, String(node.name).trim()] : folder;
  if (nextFolder.length > MAX_DEPTH) return;
  for (const child of node.children) visit(child, nextFolder, bookmarks);
}

function textValue(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function folderNodeId(node, fallback) {
  return textValue(node?.id, fallback);
}

function itemNodeId(node, fallback) {
  return textValue(node?.id, fallback);
}

function buildBookmarkModel(document) {
  const bookmarks = [];
  const folders = [];
  const roots = [];
  const rootEntries = Object.entries(document?.roots || {});

  function visitFolder(node, { id, parentId, index, path, depth }) {
    if (!node || typeof node !== "object" || depth > MAX_DEPTH) return null;
    const title = textValue(node.name, id);
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
        const childId = folderNodeId(
          child,
          `${folder.id}/${childIndex + 1}`,
        );
        const nested = visitFolder(child, {
          id: childId,
          parentId: folder.id,
          index: childIndex + 1,
          path: nextPath,
          depth: depth + 1,
        });
        if (nested) folder.folders.push(nested);
        continue;
      }
      if (child?.type !== "url") continue;
      const url = bookmarkUrl(child.url);
      const titleValue = textValue(child.name, "");
      if (!url || !titleValue || bookmarks.length >= MAX_BOOKMARKS) continue;
      const item = {
        id: itemNodeId(child, `${bookmarks.length + 1}`),
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

  for (const [rootIndex, [rootKey, root]] of rootEntries.entries()) {
    const folder = visitFolder(root, {
      id: folderNodeId(root, rootKey),
      parentId: null,
      index: rootIndex + 1,
      path: [],
      depth: 0,
    });
    if (folder) roots.push(folder);
  }
  return { bookmarks, folders, roots, bookmarkFolders: roots };
}

export function parseBookmarkModel(document) {
  return buildBookmarkModel(document);
}

export function parseBookmarksDocument(document) {
  return buildBookmarkModel(document).bookmarks.map(
    ({ id, name, url, folder }) => ({ id, name, url, folder }),
  );
}

export function readBookmarksDocument(path) {
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    return document && typeof document === "object" ? document : null;
  } catch {
    return null;
  }
}

export function readBookmarks(path) {
  return parseBookmarksDocument(readBookmarksDocument(path));
}

export function readBookmarkModel(path) {
  return parseBookmarkModel(readBookmarksDocument(path));
}

function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document || {}));
}

function ensureBookmarkBar(document) {
  const next = cloneDocument(document);
  if (!next.roots || typeof next.roots !== "object") next.roots = {};
  if (!next.roots.bookmark_bar || typeof next.roots.bookmark_bar !== "object") {
    next.roots.bookmark_bar = {
      children: [],
      date_added: "0",
      date_modified: "0",
      id: "1",
      name: "Bookmarks bar",
      type: "folder",
    };
  }
  if (!Array.isArray(next.roots.bookmark_bar.children)) {
    next.roots.bookmark_bar.children = [];
  }
  next.version = Number(next.version) || 1;
  return next;
}

function visitNodes(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitNodes(child, callback);
  }
}

function nextBookmarkId(document) {
  let largest = 0;
  for (const root of Object.values(document.roots || {})) {
    visitNodes(root, (node) => {
      const id = Number(node.id);
      if (Number.isInteger(id)) largest = Math.max(largest, id);
    });
  }
  return String(largest + 1);
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function addBookmarkToDocument(
  document,
  { url, name, parentId = "1", dateAdded = Date.now() } = {},
) {
  const canonical = canonicalUrl(url);
  const title = String(name || "").trim();
  if (!canonical || !title) return { document: cloneDocument(document), added: false };
  const next = ensureBookmarkBar(document);
  const parent = findFolderNode(next, parentId || "1");
  if (!parent) return { document: next, added: false };
  const existing = parseBookmarksDocument(next).find(
    (bookmark) => bookmark.url === canonical,
  );
  if (existing) return { document: next, added: false, bookmark: existing };
  const timestamp = String((Number(dateAdded) + 11644473600000) * 1000);
  const bookmark = {
    date_added: timestamp,
    guid: randomUUID(),
    id: nextBookmarkId(next),
    name: title.slice(0, 160),
    type: "url",
    url: canonical,
  };
  parent.children ||= [];
  parent.children.push(bookmark);
  return {
    document: next,
    added: true,
    bookmark:
      parseBookmarkModel(next).bookmarks.find(
        (candidate) => candidate.id === bookmark.id,
      ) || {
        id: bookmark.id,
        name: bookmark.name,
        url: bookmark.url,
        folder: "Bookmarks bar",
      },
  };
}

export function removeBookmarkItemFromDocument(document, { id, url } = {}) {
  const canonical = canonicalUrl(url);
  const requestedId = id === undefined || id === null ? null : String(id);
  const next = cloneDocument(document);
  if (!canonical && !requestedId) return { document: next, removed: 0 };
  let removed = 0;
  function removeFrom(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      const matchesId = requestedId && String(child?.id || "") === requestedId;
      const matchesUrl = canonical && canonicalUrl(child?.url) === canonical;
      if (child?.type === "url" && (matchesId || matchesUrl)) {
        removed += 1;
        return false;
      }
      removeFrom(child);
      return true;
    });
  }
  for (const root of Object.values(next.roots || {})) removeFrom(root);
  return { document: next, removed };
}

export function removeBookmarkFromDocument(document, url) {
  return removeBookmarkItemFromDocument(document, { url });
}

function findFolderNode(document, folderId) {
  const requestedId = String(folderId || "");
  if (!requestedId) return null;
  for (const root of Object.values(document?.roots || {})) {
    let found = null;
    visitNodes(root, (node) => {
      if (!found && node?.type === "folder" && String(node.id) === requestedId) {
        found = node;
      }
    });
    if (found) return found;
  }
  return null;
}

export function addBookmarkFolderToDocument(
  document,
  { title, parentId = "1" } = {},
) {
  const name = String(title || "").trim().slice(0, 160);
  const next = ensureBookmarkBar(document);
  const parent = findFolderNode(next, parentId || "1");
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
    folder: parseBookmarkModel(next).folders.find(
      (candidate) => candidate.id === folder.id,
    ),
  };
}

export function renameBookmarkFolderInDocument(document, { id, title } = {}) {
  const next = ensureBookmarkBar(document);
  const folder = findFolderNode(next, id);
  const name = String(title || "").trim().slice(0, 160);
  if (!folder || !name) return { document: next, renamed: false, folder: null };
  folder.name = name;
  return {
    document: next,
    renamed: true,
    folder: parseBookmarkModel(next).folders.find(
      (candidate) => candidate.id === String(id),
    ),
  };
}

export function removeBookmarkFolderFromDocument(document, folderId) {
  const requestedId = String(folderId || "");
  const next = cloneDocument(document);
  let removed = 0;
  function removeFrom(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      if (child?.type === "folder" && String(child.id) === requestedId) {
        removed += 1;
        return false;
      }
      removeFrom(child);
      return true;
    });
  }
  for (const root of Object.values(next.roots || {})) removeFrom(root);
  return { document: next, removed };
}
