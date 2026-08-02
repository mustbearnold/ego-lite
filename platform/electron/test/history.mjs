import assert from "node:assert/strict";
import {
  historyDocument,
  readHistoryDocument,
  recordHistory,
} from "../history.mjs";

const first = recordHistory([], {
  url: "https://example.test/one",
  title: "One",
  visitedAt: "2026-08-02T00:00:00.000Z",
});
const second = recordHistory(first, {
  url: "https://example.test/two",
  title: "Two",
  visitedAt: "2026-08-02T00:01:00.000Z",
});
const revisited = recordHistory(second, {
  url: "https://example.test/one",
  title: "One updated",
  visitedAt: "2026-08-02T00:02:00.000Z",
});

assert.deepEqual(revisited.map((entry) => entry.url), [
  "https://example.test/one",
  "https://example.test/two",
]);
assert.equal(revisited[0].title, "One updated");
assert.equal(recordHistory(revisited, { url: "about:blank" }).length, 2);
assert.deepEqual(
  readHistoryDocument(historyDocument(revisited)),
  revisited,
);
assert.deepEqual(readHistoryDocument({ version: 99, entries: revisited }), []);

console.log(JSON.stringify({ entries: revisited.length, deduplicated: true }));
