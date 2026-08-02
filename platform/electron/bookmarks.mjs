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

export function parseBookmarksDocument(document) {
  const bookmarks = [];
  const roots = document?.roots;
  if (!roots || typeof roots !== "object") return bookmarks;
  for (const root of Object.values(roots)) {
    visit(root, [], bookmarks);
    if (bookmarks.length >= MAX_BOOKMARKS) break;
  }
  return bookmarks;
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
  { url, name, dateAdded = Date.now() } = {},
) {
  const canonical = canonicalUrl(url);
  const title = String(name || "").trim();
  if (!canonical || !title) return { document: cloneDocument(document), added: false };
  const next = ensureBookmarkBar(document);
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
  next.roots.bookmark_bar.children.push(bookmark);
  return {
    document: next,
    added: true,
    bookmark: {
      id: bookmark.id,
      name: bookmark.name,
      url: bookmark.url,
      folder: "Bookmarks bar",
    },
  };
}

export function removeBookmarkFromDocument(document, url) {
  const canonical = canonicalUrl(url);
  const next = cloneDocument(document);
  if (!canonical) return { document: next, removed: 0 };
  let removed = 0;
  function removeFrom(node) {
    if (!Array.isArray(node?.children)) return;
    node.children = node.children.filter((child) => {
      if (child?.type === "url" && canonicalUrl(child.url) === canonical) {
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
