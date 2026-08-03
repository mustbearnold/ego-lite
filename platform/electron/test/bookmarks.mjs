import assert from "node:assert/strict";
import {
  addBookmarkFolderToDocument,
  addBookmarkToDocument,
  parseBookmarkModel,
  parseBookmarksDocument,
  removeBookmarkFolderFromDocument,
  removeBookmarkItemFromDocument,
  removeBookmarkFromDocument,
  renameBookmarkFolderInDocument,
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

const model = parseBookmarkModel({
  roots: {
    bookmark_bar: {
      type: "folder",
      id: "1",
      name: "Bookmarks bar",
      children: [
        {
          type: "folder",
          id: "7",
          name: "Projects",
          children: [
            {
              type: "url",
              id: "8",
              name: "Project home",
              url: "https://project.example/",
            },
          ],
        },
      ],
    },
  },
});
assert.equal(model.bookmarkFolders[0].id, "1");
assert.equal(model.bookmarkFolders[0].folders[0].id, "7");
assert.equal(model.bookmarkFolders[0].folders[0].items[0].folderId, "7");
assert.equal(model.bookmarks[0].title, "Project home");
assert.equal(model.bookmarks[0].index, 1);

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
const folderAdded = addBookmarkFolderToDocument(added.document, {
  title: "Projects",
});
assert.equal(folderAdded.added, true);
const folderId = folderAdded.folder.id;
const nestedBookmark = addBookmarkToDocument(folderAdded.document, {
  url: "https://nested.example/",
  name: "Nested",
  parentId: folderId,
});
assert.equal(nestedBookmark.added, true);
assert.equal(nestedBookmark.bookmark.folderId, folderId);
assert.equal(nestedBookmark.bookmark.folder, "Bookmarks bar / Projects");
const renamedFolder = renameBookmarkFolderInDocument(nestedBookmark.document, {
  id: folderId,
  title: "Renamed projects",
});
assert.equal(renamedFolder.renamed, true);
assert.equal(renamedFolder.folder.title, "Renamed projects");
const removedItem = removeBookmarkItemFromDocument(renamedFolder.document, {
  id: nestedBookmark.bookmark.id,
});
assert.equal(removedItem.removed, 1);
const removedFolder = removeBookmarkFolderFromDocument(
  removedItem.document,
  folderId,
);
assert.equal(removedFolder.removed, 1);
const removed = removeBookmarkFromDocument(added.document, "https://new.example/");
assert.equal(removed.removed, 1);
assert.deepEqual(parseBookmarksDocument(removed.document), []);

console.log(JSON.stringify({ count: bookmarks.length, bookmarks }));
