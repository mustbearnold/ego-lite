const HISTORY_VERSION = 1;
const HISTORY_LIMIT = 100;

function historyEntry(value) {
  const url = String(value?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    title: String(value?.title || "").trim().slice(0, 240),
    visitedAt: String(value?.visitedAt || new Date().toISOString()),
  };
}

export function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map(historyEntry).filter(Boolean).slice(0, HISTORY_LIMIT);
}

export function recordHistory(value, entry) {
  const next = historyEntry(entry);
  if (!next) return normalizeHistory(value);
  return [next, ...normalizeHistory(value).filter((item) => item.url !== next.url)].slice(
    0,
    HISTORY_LIMIT,
  );
}

export function historyDocument(entries) {
  return {
    version: HISTORY_VERSION,
    entries: normalizeHistory(entries),
  };
}

export function readHistoryDocument(value) {
  if (value?.version !== HISTORY_VERSION) return [];
  return normalizeHistory(value.entries);
}
