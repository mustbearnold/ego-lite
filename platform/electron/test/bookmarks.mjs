import assert from "node:assert/strict";
import {
  addBookmarkToDocument,
  parseBookmarksDocument,
  removeBookmarkFromDocument,
} from "../bookmarks.mjs";

const bookmarks = parseBookmarksDocument({
  roots: {
    bookmark_bar: {
      name: "Bookmarks bar",
      children: [
        {
          type: "url",
          id: "1",
          name: "Example",
          url: "https://example.com/",
        },
        {
          type: "folder",
          name: "Work",
          children: [
            {
              type: "url",
              id: "2",
              name: "Internal",
              url: "https://internal.example.test/",
            },
          ],
        },
        {
          type: "url",
          name: "Unsafe",
          url: "javascript:alert(1)",
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other bookmarks",
      children: [],
    },
    synced: {
      type: "folder",
      name: "Synced",
      children: [
        {
          type: "url",
          name: "Synced bookmark",
          url: "https://synced.example.test/",
        },
      ],
    },
  },
});

assert.deepEqual(bookmarks, [
  {
    id: "1",
    name: "Example",
    url: "https://example.com/",
    folder: "Bookmarks bar",
  },
  {
    id: "2",
    name: "Internal",
    url: "https://internal.example.test/",
    folder: "Bookmarks bar / Work",
  },
  {
    id: "3",
    name: "Synced bookmark",
    url: "https://synced.example.test/",
    folder: "Synced",
  },
]);

const added = addBookmarkToDocument(
  { roots: {} },
  {
    url: "https://new.example/",
    name: "New bookmark",
    dateAdded: Date.parse("2026-08-02T00:00:00.000Z"),
  },
);
assert.equal(added.added, true);
assert.deepEqual(parseBookmarksDocument(added.document), [
  {
    id: added.bookmark.id,
    name: "New bookmark",
    url: "https://new.example/",
    folder: "Bookmarks bar",
  },
]);
assert.equal(
  addBookmarkToDocument(added.document, {
    url: "https://new.example/",
    name: "Duplicate",
  }).added,
  false,
);
const removed = removeBookmarkFromDocument(added.document, "https://new.example/");
assert.equal(removed.removed, 1);
assert.deepEqual(parseBookmarksDocument(removed.document), []);

console.log(JSON.stringify({ count: bookmarks.length, bookmarks }));
