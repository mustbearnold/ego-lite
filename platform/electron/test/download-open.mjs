import assert from "node:assert/strict";
import { openDownloadPath } from "../downloads.mjs";

let openedPath = null;
const opened = await openDownloadPath(
  "/tmp/ego-lite-download-fixture.txt",
  async (path) => {
    openedPath = path;
    return "";
  },
);
assert.deepEqual(opened, {
  opened: true,
  path: "/tmp/ego-lite-download-fixture.txt",
});
assert.equal(openedPath, "/tmp/ego-lite-download-fixture.txt");

await assert.rejects(
  () => openDownloadPath(null, async () => ""),
  /download is not ready/,
);
await assert.rejects(
  () =>
    openDownloadPath(
      "/tmp/ego-lite-download-fixture.txt",
      async () => "No application is associated with this file",
    ),
  /No application is associated with this file/,
);

console.log(JSON.stringify({ opened: opened.path, rejectedUnavailable: true }));
