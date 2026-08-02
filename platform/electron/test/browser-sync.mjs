import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mergeHistoryEntries,
  normalizeBrowserSyncConfig,
  readBrowserSourceData,
  readBrowserSourceDataInWorker,
  shouldRunAutomaticBrowserSync,
} from "../browser-sync.mjs";

const fixtureDir = await mkdtemp(join(tmpdir(), "ego-browser-sync-"));
try {
  await writeFile(
    join(fixtureDir, "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            {
              type: "url",
              id: "1",
              name: "Example",
              url: "https://example.com/",
            },
          ],
        },
      },
    }),
  );

  const historyPath = join(fixtureDir, "History");
  const database = new DatabaseSync(historyPath);
  database.exec(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)",
  );
  const visit = Date.parse("2026-08-02T10:00:00.000Z");
  database
    .prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)")
    .run(
      "https://example.com/",
      "Example",
      (visit + 11644473600000) * 1000,
    );
  database
    .prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)")
    .run(
      "https://second.example/",
      "Second",
      (visit + 11644473600000 - 1000) * 1000,
    );
  database.close();

  const source = await readBrowserSourceData(fixtureDir);
  assert.equal(source.bookmarks.length, 1);
  assert.deepEqual(
    source.history.map((entry) => entry.url),
    ["https://example.com/", "https://second.example/"],
  );
  assert.equal(source.history[0].visitedAt, "2026-08-02T10:00:00.000Z");

  const workerSource = await readBrowserSourceDataInWorker(fixtureDir);
  assert.equal(workerSource.bookmarks.length, 1);
  assert.deepEqual(
    workerSource.history.map((entry) => entry.url),
    source.history.map((entry) => entry.url),
  );

  const merged = mergeHistoryEntries(
    [
      {
        url: "https://example.com/",
        title: "Older",
        visitedAt: "2026-08-02T09:00:00.000Z",
      },
      {
        url: "https://local.example/",
        title: "Local",
        visitedAt: "2026-08-02T11:00:00.000Z",
      },
    ],
    source.history,
  );
  assert.deepEqual(merged.map((entry) => entry.url), [
    "https://local.example/",
    "https://example.com/",
    "https://second.example/",
  ]);
  assert.equal(merged[1].title, "Example");

  const config = normalizeBrowserSyncConfig({
    enabled: true,
    sourceProfileDir: fixtureDir,
    intervalMinutes: 1,
  });
  assert.equal(config.intervalMinutes, 5);
  assert.equal(config.sourceProfileDir, fixtureDir);

  const now = Date.parse("2026-08-02T12:00:00.000Z");
  assert.equal(
    shouldRunAutomaticBrowserSync(
      {
        enabled: true,
        intervalMinutes: 15,
        lastSyncAt: "2026-08-02T11:30:00.000Z",
      },
      { now },
    ),
    true,
  );
  assert.equal(
    shouldRunAutomaticBrowserSync(
      {
        enabled: true,
        intervalMinutes: 15,
        lastSyncAt: "2026-08-02T11:55:00.000Z",
      },
      { now },
    ),
    false,
  );
  assert.equal(
    shouldRunAutomaticBrowserSync(
      { enabled: true, intervalMinutes: 15 },
      { isDefaultBrowser: true, now },
    ),
    false,
  );

  console.log(
    JSON.stringify({
      bookmarks: source.bookmarks.length,
      history: source.history.length,
      workerHistory: workerSource.history.length,
      merged: merged.length,
      intervalMinutes: config.intervalMinutes,
    }),
  );
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}
