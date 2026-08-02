import assert from "node:assert/strict";
import {
  addReadingListEntry,
  readReadingListDocument,
  readingListDocument,
  removeReadingListEntry,
} from "../reading-list.mjs";

const first = addReadingListEntry([], {
  url: "https://example.test/one",
  title: "One",
  addedAt: "2026-08-02T00:00:00.000Z",
});
const second = addReadingListEntry(first, {
  url: "https://example.test/two",
  title: "Two",
  addedAt: "2026-08-02T00:01:00.000Z",
});
const revisited = addReadingListEntry(second, {
  url: "https://example.test/one",
  title: "One updated",
  addedAt: "2026-08-02T00:02:00.000Z",
});

assert.deepEqual(revisited.map((entry) => entry.url), [
  "https://example.test/one",
  "https://example.test/two",
]);
assert.equal(removeReadingListEntry(revisited, "https://example.test/two").length, 1);
assert.equal(addReadingListEntry(revisited, { url: "about:blank" }).length, 2);
assert.deepEqual(
  readReadingListDocument(readingListDocument(revisited)),
  revisited,
);

console.log(JSON.stringify({ entries: revisited.length, deduplicated: true }));
