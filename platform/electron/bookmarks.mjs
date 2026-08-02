import { readFileSync } from "node:fs";

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

export function readBookmarks(path) {
  try {
    return parseBookmarksDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}
