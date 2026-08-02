const READING_LIST_VERSION = 1;
const READING_LIST_LIMIT = 100;

function readingEntry(value) {
  const url = String(value?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    title: String(value?.title || "").trim().slice(0, 240),
    addedAt: String(value?.addedAt || new Date().toISOString()),
  };
}

export function normalizeReadingList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(readingEntry)
    .filter((entry) => {
      if (!entry || seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .slice(0, READING_LIST_LIMIT);
}

export function addReadingListEntry(value, entry) {
  const next = readingEntry(entry);
  if (!next) return normalizeReadingList(value);
  return [
    next,
    ...normalizeReadingList(value).filter((item) => item.url !== next.url),
  ].slice(0, READING_LIST_LIMIT);
}

export function removeReadingListEntry(value, url) {
  const target = String(url || "").trim();
  return normalizeReadingList(value).filter((entry) => entry.url !== target);
}

export function readingListDocument(entries) {
  return {
    version: READING_LIST_VERSION,
    entries: normalizeReadingList(entries),
  };
}

export function readReadingListDocument(value) {
  if (value?.version !== READING_LIST_VERSION) return [];
  return normalizeReadingList(value.entries);
}
