import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMigrationProfiles,
  findSingleMigrationProfile,
  profileLooksUsable,
} from "../migration-discovery.mjs";

test("finds the only usable Chrome-family profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-migration-discovery-"));
  try {
    const profileDir = join(root, "google-chrome", "Default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "Preferences"), "{}\n");

    assert.equal(await profileLooksUsable(profileDir), true);
    assert.deepEqual(
      await findSingleMigrationProfile([
        { name: "Google Chrome", userDataDir: join(root, "google-chrome") },
      ]),
      {
        name: "Google Chrome",
        userDataDir: join(root, "google-chrome"),
        profileDir,
        profileName: "Default",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not guess when more than one supported profile is usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-migration-discovery-"));
  try {
    const userDataDir = join(root, "chromium");
    for (const profileName of ["Default", "Profile 1"]) {
      const profileDir = join(userDataDir, profileName);
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, "Bookmarks"), "{}\n");
    }
    assert.equal(
      await findSingleMigrationProfile([{ name: "Chromium", userDataDir }]),
      null,
    );
    const profiles = await findMigrationProfiles([
      { name: "Chromium", userDataDir },
    ]);
    assert.deepEqual(
      profiles.map(({ name, profileName }) => ({ name, profileName })),
      [
        { name: "Chromium", profileName: "Default" },
        { name: "Chromium", profileName: "Profile 1" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
