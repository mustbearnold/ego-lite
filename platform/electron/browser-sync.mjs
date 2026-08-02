import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readBookmarks } from "./bookmarks.mjs";
import { normalizeHistory } from "./history.mjs";

export const BROWSER_SYNC_VERSION = 1;
export const DEFAULT_BROWSER_SYNC_INTERVAL_MINUTES = 15;
export const MIN_BROWSER_SYNC_INTERVAL_MINUTES = 5;
export const MAX_BROWSER_SYNC_INTERVAL_MINUTES = 24 * 60;

function boundedInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_BROWSER_SYNC_INTERVAL_MINUTES;
  return Math.min(
    MAX_BROWSER_SYNC_INTERVAL_MINUTES,
    Math.max(MIN_BROWSER_SYNC_INTERVAL_MINUTES, Math.round(number)),
  );
}

function isoDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeBrowserSyncConfig(value = {}) {
  const sourceProfileDir = String(value.sourceProfileDir || "").trim();
  return {
    version: BROWSER_SYNC_VERSION,
    enabled: Boolean(value.enabled),
    sourceProfileDir: sourceProfileDir ? resolve(sourceProfileDir) : null,
    sourceName: String(value.sourceName || "").trim().slice(0, 120) || null,
    intervalMinutes: boundedInterval(value.intervalMinutes),
    lastSyncAt: isoDateOrNull(value.lastSyncAt),
  };
}

export function browserSyncDocument(value = {}) {
  return normalizeBrowserSyncConfig(value);
}

export function sourceProfileName(profileDir) {
  const value = String(profileDir || "").trim();
  return value ? basename(resolve(value)) : null;
}

function chromiumTimestamp(value) {
  let timestamp;
  try {
    timestamp = BigInt(String(value));
  } catch {
    return null;
  }
  if (timestamp <= 0n) return null;
  const milliseconds = timestamp / 1000n - 11644473600000n;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function readChromiumHistory(historyPath, { limit = 100 } = {}) {
  if (!existsSync(historyPath)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(historyPath, { readOnly: true });
  try {
    const boundedLimit = Math.max(1, Math.min(500, Math.round(Number(limit) || 100)));
    const rows = database
      .prepare(
        `SELECT url, title, CAST(last_visit_time AS TEXT) AS last_visit_time
         FROM urls
         WHERE url LIKE 'http://%' OR url LIKE 'https://%'
         ORDER BY last_visit_time DESC
         LIMIT ?`,
      )
      .all(boundedLimit);
    return normalizeHistory(
      rows.map((row) => ({
        url: row.url,
        title: row.title,
        visitedAt:
          chromiumTimestamp(row.last_visit_time) || new Date().toISOString(),
      })),
    );
  } finally {
    database.close();
  }
}

export async function readBrowserSourceData(profileDir) {
  const source = resolve(String(profileDir || ""));
  const bookmarksPath = join(source, "Bookmarks");
  const historyPath = join(source, "History");
  return {
    profileDir: source,
    sourceName: sourceProfileName(source),
    bookmarks: existsSync(bookmarksPath) ? readBookmarks(bookmarksPath) : null,
    history: await readChromiumHistory(historyPath),
  };
}

function historyTimestamp(entry) {
  const value = Date.parse(String(entry?.visitedAt || ""));
  return Number.isFinite(value) ? value : 0;
}

export function mergeHistoryEntries(current = [], imported = []) {
  const byUrl = new Map();
  for (const entry of normalizeHistory(current)) byUrl.set(entry.url, entry);
  for (const entry of normalizeHistory(imported)) {
    const previous = byUrl.get(entry.url);
    if (!previous || historyTimestamp(entry) >= historyTimestamp(previous)) {
      byUrl.set(entry.url, entry);
    }
  }
  return [...byUrl.values()]
    .sort((left, right) => historyTimestamp(right) - historyTimestamp(left))
    .slice(0, 100);
}
