import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PROFILE_NAMES = ["Default"];
const PROFILE_DIRECTORY_PATTERN = /^Profile \d+$/;
const PORTABLE_PROFILE_ENTRIES = [
  "Bookmarks",
  "History",
  "Preferences",
  "Secure Preferences",
  "Web Data",
  "Extensions",
];

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function profileLooksUsable(profileDir) {
  for (const entry of PORTABLE_PROFILE_ENTRIES) {
    if (await pathExists(join(profileDir, entry))) return true;
  }
  return false;
}

async function profileDirectories(userDataDir) {
  const names = new Set(PROFILE_NAMES);
  try {
    const entries = await readdir(userDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && PROFILE_DIRECTORY_PATTERN.test(entry.name)) {
        names.add(entry.name);
      }
    }
  } catch {
    return [];
  }
  return [...names].map((name) => join(userDataDir, name));
}

export function defaultMigrationSources(
  configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
) {
  return [
    { name: "Chromium", userDataDir: join(configHome, "chromium") },
    { name: "Google Chrome", userDataDir: join(configHome, "google-chrome") },
    {
      name: "Google Chrome Beta",
      userDataDir: join(configHome, "google-chrome-beta"),
    },
    {
      name: "Brave",
      userDataDir: join(configHome, "BraveSoftware", "Brave-Browser"),
    },
  ];
}

export async function findMigrationProfiles(
  sources = defaultMigrationSources(),
) {
  const candidates = [];
  for (const source of sources) {
    for (const profileDir of await profileDirectories(source.userDataDir)) {
      if (await profileLooksUsable(profileDir)) {
        candidates.push({
          name: source.name,
          userDataDir: source.userDataDir,
          profileDir,
          profileName: basename(profileDir),
        });
      }
    }
  }
  return candidates;
}

export async function findSingleMigrationProfile(
  sources = defaultMigrationSources(),
) {
  const candidates = await findMigrationProfiles(sources);
  return candidates.length === 1 ? candidates[0] : null;
}
