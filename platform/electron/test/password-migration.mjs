import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { inspectPasswordMigration } from "../../linux/ego-browser.mjs";

const root = await mkdtemp(join(tmpdir(), "ego-password-migration-"));
const userDataDir = join(root, "source-browser");
const profileDir = join(userDataDir, "Default");
const source = { userDataDir, profileDir };

try {
  await mkdir(profileDir, { recursive: true });
  assert.deepEqual(await inspectPasswordMigration(source), {
    store: "none",
    importable: false,
  });

  await writeFile(join(profileDir, "Login Data"), "plaintext password fixture");
  assert.deepEqual(await inspectPasswordMigration(source), {
    store: "basic",
    importable: true,
  });

  await writeFile(
    join(userDataDir, "Local State"),
    '{"os_crypt":{"scheme":"gnome_libsecret"}}\n',
  );
  assert.deepEqual(await inspectPasswordMigration(source), {
    store: "gnome_libsecret",
    importable: false,
  });

  await writeFile(join(userDataDir, "Local State"), "{}\n");
  await writeFile(join(profileDir, "Login Data"), "encrypted v11 fixture");
  assert.deepEqual(await inspectPasswordMigration(source), {
    store: "encrypted",
    importable: false,
  });

  console.log(
    JSON.stringify({
      basicPlaintext: true,
      keyringStoreExcluded: true,
      encryptedMarkerExcluded: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
