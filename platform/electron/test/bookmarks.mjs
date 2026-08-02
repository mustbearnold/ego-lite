import assert from "node:assert/strict";
import { parseBookmarksDocument } from "../bookmarks.mjs";

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

console.log(JSON.stringify({ count: bookmarks.length, bookmarks }));
