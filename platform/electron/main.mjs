import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
} from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  findMigrationProfiles,
  findSingleMigrationProfile,
  profileLooksUsable,
} from "./migration-discovery.mjs";
import {
  addBookmarkToDocument,
  readBookmarks,
  readBookmarksDocument,
  removeBookmarkFromDocument,
} from "./bookmarks.mjs";
import {
  browserSyncDocument,
  mergeHistoryEntries,
  normalizeBrowserSyncConfig,
  readBrowserSourceDataInWorker,
  shouldRunAutomaticBrowserSync,
  sourceProfileName,
} from "./browser-sync.mjs";
import { openDownloadPath } from "./downloads.mjs";
import {
  historyDocument,
  readHistoryDocument,
  recordHistory,
} from "./history.mjs";
import {
  addReadingListEntry,
  readReadingListDocument,
  readingListDocument,
  removeReadingListEntry,
} from "./reading-list.mjs";
import { createUpdateController } from "./update.mjs";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const ELECTRON_ENTRY_ARGUMENT = process.argv[1] || "";
const WELCOME_URL = pathToFileURL(
  join(MAIN_DIR, "renderer", "welcome.html"),
).toString();
const CLI_MODE = process.argv.includes("--cli");
const CLI_PROFILE_MIGRATION =
  CLI_MODE && process.argv.includes("--migrate-profile");

function argumentValue(flag) {
  const exactIndex = process.argv.indexOf(flag);
  if (exactIndex >= 0) return process.argv[exactIndex + 1] || null;
  const prefix = `${flag}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  );
}

function validProfileId(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(candidate)
    ? candidate
    : "default";
}

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function normalizeServerName(value, { strict = false } = {}) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return "default";
  if (SERVER_NAME_PATTERN.test(candidate)) return candidate;
  if (strict) {
    throw new Error(
      "server name must start with a letter or number and contain only letters, numbers, hyphens, or underscores",
    );
  }
  return "default";
}

function serverDataRoot(baseRoot, serverName) {
  const normalized = normalizeServerName(serverName);
  return normalized === "default"
    ? baseRoot
    : join(baseRoot, "servers", normalized);
}

const ACTIVE_PROFILE_ID = validProfileId(
  argumentValue("--profile") || process.env.EGO_LITE_PROFILE_ID || "default",
);
const requestedServerName =
  argumentValue("--server-name") || process.env.EGO_LITE_SERVER_NAME || "";
const SERVER_NAME = normalizeServerName(requestedServerName, {
  strict: Boolean(requestedServerName),
});
const PROFILE_STORAGE_ROOT = resolve(
  serverDataRoot(
    process.env.EGO_LITE_PROFILE_ROOT ||
      join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "ego-lite",
      ),
    SERVER_NAME,
  ),
);
const PROFILE_REGISTRY_PATH = join(PROFILE_STORAGE_ROOT, "profiles.json");
const PROFILE_MANAGER_ENABLED =
  !process.env.EGO_LITE_PROFILE_DIR && !CLI_MODE && !CLI_PROFILE_MIGRATION;
const PROFILE_DIR = resolve(
  process.env.EGO_LITE_PROFILE_DIR ||
    (ACTIVE_PROFILE_ID === "default"
      ? join(PROFILE_STORAGE_ROOT, "chromium-profile")
      : join(
          PROFILE_STORAGE_ROOT,
          "profiles",
          ACTIVE_PROFILE_ID,
          "chromium-profile",
        )),
);
const STATE_PATH = resolve(
  process.env.EGO_LITE_STATE_PATH ||
    join(
      serverDataRoot(
        join(
          process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
          "ego-lite",
        ),
        SERVER_NAME,
      ),
      ...(ACTIVE_PROFILE_ID === "default"
        ? ["task-spaces.json"]
        : ["profiles", ACTIVE_PROFILE_ID, "task-spaces.json"]),
    ),
);
const WINDOW_STATE_PATH = resolve(
  process.env.EGO_LITE_WINDOW_STATE_PATH ||
    join(PROFILE_DIR, "ego-lite-window.json"),
);
const EXTENSION_STATE_PATH = resolve(
  process.env.EGO_LITE_EXTENSION_STATE_PATH ||
    join(PROFILE_DIR, "ego-lite-extensions.json"),
);
const TOOLBAR_HEIGHT = 52;
const TAB_STRIP_HEIGHT = 36;
const WINDOW_MIN_WIDTH = 720;
const WINDOW_MIN_HEIGHT = 480;
const WINDOW_DEFAULT_WIDTH = 1440;
const WINDOW_DEFAULT_HEIGHT = 900;

mkdirSync(PROFILE_DIR, { recursive: true });
app.setPath("userData", PROFILE_DIR);
app.setName("ego lite");
app.setAppUserModelId("com.citrolabs.ego-lite");
if (!CLI_PROFILE_MIGRATION) {
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}
app.commandLine.appendSwitch("password-store", "basic");
app.commandLine.appendSwitch("enable-automation");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (process.getuid?.() === 0) app.commandLine.appendSwitch("no-sandbox");
if (process.env.EGO_LITE_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}

let mainWindow;
let browserView;
const managedViews = new Map();
const closedPrimaryTabs = [];
const sessionPermissionStates = new WeakMap();
const sessionExtensionLoads = new WeakMap();
const sessionExtensionStates = new WeakMap();
const extensionCatalog = new Map();
let bridgeServer;
let bridgeToken;
let browserStateSyncTimer;
let browserDataSyncTimer;
let windowStateSaveTimer;
let updateController;
const downloadStates = new Map();
const downloadSessions = new WeakSet();
const DOWNLOAD_DIR = resolve(
  process.env.EGO_LITE_DOWNLOAD_DIR || join(homedir(), "Downloads"),
);
let updateState = {
  status: "disabled",
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
  message: null,
};
let bookmarks = [];
const agentTaskStates = new Map();
const bridgeFile = join(PROFILE_DIR, "ego-lite-bridge.json");
const MIGRATION_PROMPT_MARKER = join(PROFILE_DIR, ".migration-prompted");
const WELCOME_MARKER = join(PROFILE_DIR, ".welcome-seen");
const MIGRATED_TABS_FILE = "ego-lite-migrated-tabs.json";
const PRIMARY_SESSION_FILE = "ego-lite-session.json";
const PRIMARY_SESSION_PATH = join(PROFILE_DIR, PRIMARY_SESSION_FILE);
const PENDING_IMPORT_FILE = "ego-lite-pending-import.json";
const PENDING_IMPORT_PATH = join(PROFILE_DIR, PENDING_IMPORT_FILE);
const SPACE_SESSION_FILE = "ego-lite-space-session.json";
const SPACE_SESSION_PATH = join(PROFILE_DIR, SPACE_SESSION_FILE);
const BOOKMARKS_PATH = join(PROFILE_DIR, "Default", "Bookmarks");
const HISTORY_PATH = join(PROFILE_DIR, "ego-lite-history.json");
const READING_LIST_PATH = join(PROFILE_DIR, "ego-lite-reading-list.json");
const BROWSER_SYNC_PATH = join(PROFILE_DIR, "ego-lite-browser-sync.json");
let sessionSaveTimer;
let spaceSaveTimer;
let importRequestPending = false;
let historyEntries = [];
let readingListEntries = [];
let browserSyncConfig;
let browserSyncBusy = false;
let browserSyncState = {
  status: "disabled",
  message: null,
  importedBookmarks: 0,
  importedHistory: 0,
  lastSyncAt: null,
};

const permissionAliases = {
  clipboardReadWrite: ["clipboard-read", "clipboard-sanitized-write"],
  clipboardSanitizedWrite: ["clipboard-sanitized-write"],
  audioCapture: ["media"],
  camera: ["media"],
  displayCapture: ["display-capture"],
  microphone: ["media"],
  videoCapture: ["media"],
};

function normalizeUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "about:blank";
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(candidate);
  if (
    !new Set(["about:", "data:", "file:", "http:", "https:"]).has(url.protocol)
  ) {
    throw new Error(`unsupported browser URL scheme: ${url.protocol}`);
  }
  return url.toString();
}

const EXTERNAL_TARGET_PROTOCOLS = new Set(["file:", "http:", "https:"]);
const EXTERNAL_ARGUMENT_FLAGS_WITH_VALUES = new Set([
  "--from",
  "--profile",
  "--sdk-path",
  "--server-name",
]);

function normalizeExternalTarget(value, cwd = process.cwd()) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    try {
      const url = new URL(input);
      return EXTERNAL_TARGET_PROTOCOLS.has(url.protocol)
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  }
  if (
    !input.startsWith("/") &&
    !input.startsWith("./") &&
    !input.startsWith("../")
  ) {
    return null;
  }
  return pathToFileURL(resolve(cwd, input)).toString();
}

function isElectronApplicationArgument(value) {
  const input = String(value || "");
  const resolvedInput = resolve(input);
  const resolvedEntry = ELECTRON_ENTRY_ARGUMENT
    ? resolve(ELECTRON_ENTRY_ARGUMENT)
    : null;
  return (
    input === MAIN_DIR ||
    input === "." ||
    input === "platform/electron" ||
    resolvedInput === MAIN_DIR ||
    resolvedInput === resolvedEntry ||
    input === process.execPath ||
    input === ELECTRON_ENTRY_ARGUMENT
  );
}

function externalTargetsFromArguments(argv, cwd = process.cwd()) {
  const targets = [];
  let endOfOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "").trim();
    if (!argument) continue;
    // Electron's second-instance command line starts with the executable path;
    // it is not necessarily equal to process.execPath in the first instance.
    if (index === 0) continue;
    if (isElectronApplicationArgument(argument)) continue;
    if (!endOfOptions && argument === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && EXTERNAL_ARGUMENT_FLAGS_WITH_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (!endOfOptions && argument.startsWith("-")) continue;
    const target = normalizeExternalTarget(argument, cwd);
    if (target) targets.push(target);
  }
  return targets;
}

const INITIAL_EXTERNAL_TARGETS = CLI_MODE
  ? []
  : externalTargetsFromArguments(process.argv);
let pendingExternalTargets = [...INITIAL_EXTERNAL_TARGETS];

function isDefaultBrowser() {
  if (process.env.EGO_LITE_DEFAULT_BROWSER === "1") return true;
  if (process.env.EGO_LITE_DEFAULT_BROWSER === "0") return false;
  try {
    return (
      app.isDefaultProtocolClient("http") ||
      app.isDefaultProtocolClient("https")
    );
  } catch {
    return false;
  }
}

function readHistory() {
  try {
    return readHistoryDocument(JSON.parse(readFileSync(HISTORY_PATH, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read history: ${error?.message || String(error)}`,
      );
    }
    return [];
  }
}

function writeBookmarksDocument(document) {
  const temporaryPath = `${BOOKMARKS_PATH}.${process.pid}.tmp`;
  mkdirSync(dirname(BOOKMARKS_PATH), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  renameSync(temporaryPath, BOOKMARKS_PATH);
}

function activeBookmarkTarget() {
  return [...managedViews.values()].find(
    (candidate) => candidate.view === browserView,
  );
}

function currentBookmarkState() {
  const active = activeBookmarkTarget();
  const url = active?.view.webContents.getURL() || "";
  const canToggle = Boolean(
    active &&
      active.spaceId === null &&
      !active.private &&
      /^https?:\/\//i.test(url),
  );
  return {
    bookmarkCanToggle: canToggle,
    bookmarked: canToggle && bookmarks.some((bookmark) => bookmark.url === url),
  };
}

function toggleCurrentBookmark() {
  const active = activeBookmarkTarget();
  const url = active?.view.webContents.getURL() || "";
  if (
    !active ||
    active.spaceId !== null ||
    active.private ||
    !/^https?:\/\//i.test(url)
  ) {
    throw new Error("bookmarks are available only for normal HTTP(S) tabs");
  }
  const document = readBookmarksDocument(BOOKMARKS_PATH) || { roots: {} };
  const existing = bookmarks.some((bookmark) => bookmark.url === url);
  const result = existing
    ? removeBookmarkFromDocument(document, url)
    : addBookmarkToDocument(document, {
        url,
        name: active.view.webContents.getTitle() || url,
      });
  if (!existing && !result.added) throw new Error("could not add bookmark");
  writeBookmarksDocument(result.document);
  bookmarks = readBookmarks(BOOKMARKS_PATH);
  publishBrowserState();
  return currentBrowserState();
}

function readBrowserSyncConfig() {
  try {
    return normalizeBrowserSyncConfig(
      JSON.parse(readFileSync(BROWSER_SYNC_PATH, "utf8")),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read browser sync settings: ${error?.message || String(error)}`,
      );
    }
    return normalizeBrowserSyncConfig();
  }
}

function writeBrowserSyncConfig() {
  const temporaryPath = `${BROWSER_SYNC_PATH}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(browserSyncDocument(browserSyncConfig), null, 2)}\n`,
  );
  renameSync(temporaryPath, BROWSER_SYNC_PATH);
}

function currentBrowserSync() {
  return {
    ...browserSyncConfig,
    status: browserSyncState.status,
    message: browserSyncState.message,
    importedBookmarks: browserSyncState.importedBookmarks,
    importedHistory: browserSyncState.importedHistory,
  };
}

function sourceIsCurrentProfile(sourceProfileDir) {
  const source = resolve(String(sourceProfileDir || ""));
  return source === resolve(PROFILE_DIR) || source === resolve(join(PROFILE_DIR, "Default"));
}

async function resolveBrowserSyncSource() {
  if (browserSyncConfig.sourceProfileDir) {
    if (sourceIsCurrentProfile(browserSyncConfig.sourceProfileDir)) {
      throw new Error("browser sync source must be separate from the ego lite profile");
    }
    if (!(await profileLooksUsable(browserSyncConfig.sourceProfileDir))) {
      throw new Error("configured browser sync profile was not found");
    }
    return {
      profileDir: browserSyncConfig.sourceProfileDir,
      sourceName:
        browserSyncConfig.sourceName ||
        sourceProfileName(browserSyncConfig.sourceProfileDir),
    };
  }

  const candidate = await findSingleMigrationProfile();
  if (!candidate) {
    throw new Error(
      "choose one Chromium-family profile before enabling browser sync",
    );
  }
  if (sourceIsCurrentProfile(candidate.profileDir)) {
    throw new Error("browser sync source must be separate from the ego lite profile");
  }
  return {
    profileDir: candidate.profileDir,
    sourceName: `${candidate.name} / ${candidate.profileName}`,
  };
}

async function runBrowserDataSync({ force = false } = {}) {
  if (browserSyncBusy) return currentBrowserSync();
  if (
    !force &&
    !shouldRunAutomaticBrowserSync(browserSyncConfig, {
      isDefaultBrowser: isDefaultBrowser(),
    })
  ) {
    return currentBrowserSync();
  }

  browserSyncBusy = true;
  browserSyncState = {
    ...browserSyncState,
    status: "syncing",
    message: null,
  };
  publishBrowserState();
  try {
    const source = await resolveBrowserSyncSource();
    const data = await readBrowserSourceDataInWorker(source.profileDir);
    const nextBookmarks = data.bookmarks ?? bookmarks;
    const nextHistory = data.history
      ? mergeHistoryEntries(historyEntries, data.history)
      : historyEntries;
    const historyChanged = JSON.stringify(nextHistory) !== JSON.stringify(historyEntries);
    if (data.bookmarksDocument) writeBookmarksDocument(data.bookmarksDocument);
    bookmarks = data.bookmarks !== null ? readBookmarks(BOOKMARKS_PATH) : nextBookmarks;
    if (historyChanged) {
      historyEntries = nextHistory;
      writeHistory();
    }
    browserSyncConfig = normalizeBrowserSyncConfig({
      ...browserSyncConfig,
      sourceProfileDir: source.profileDir,
      sourceName: source.sourceName,
      lastSyncAt: new Date().toISOString(),
    });
    writeBrowserSyncConfig();
    browserSyncState = {
      ...browserSyncState,
      status: "ready",
      message: null,
      importedBookmarks: data.bookmarks?.length || 0,
      importedHistory: data.history?.length || 0,
      lastSyncAt: browserSyncConfig.lastSyncAt,
    };
    publishBrowserState();
    return currentBrowserSync();
  } catch (error) {
    browserSyncState = {
      ...browserSyncState,
      status: "error",
      message: String(error?.message || error || "browser sync failed").slice(
        0,
        240,
      ),
    };
    publishBrowserState();
    if (force) throw error;
    return currentBrowserSync();
  } finally {
    browserSyncBusy = false;
  }
}

async function setBrowserSync({ enabled, intervalMinutes } = {}) {
  browserSyncConfig = normalizeBrowserSyncConfig({
    ...browserSyncConfig,
    ...(enabled === undefined ? {} : { enabled: Boolean(enabled) }),
    ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
  });
  writeBrowserSyncConfig();
  if (!browserSyncConfig.enabled) {
    browserSyncState = {
      ...browserSyncState,
      status: "disabled",
      message: null,
    };
    publishBrowserState();
    return currentBrowserSync();
  }
  return runBrowserDataSync({ force: true });
}

async function chooseBrowserSyncSource() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Choose browser profile to sync",
    buttonLabel: "Use profile",
    properties: ["openDirectory"],
    message: "Choose a Chromium, Chrome, or Brave profile directory.",
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return currentBrowserSync();
  }

  const selected = resolve(selection.filePaths[0]);
  let profileDir = selected;
  let sourceName = sourceProfileName(selected);
  if (!(await profileLooksUsable(selected))) {
    const candidates = await findMigrationProfiles([
      { name: "Selected browser", userDataDir: selected },
    ]);
    if (candidates.length !== 1) {
      throw new Error(
        "choose a specific Chromium-family profile directory with Bookmarks or History",
      );
    }
    profileDir = candidates[0].profileDir;
    sourceName = `${candidates[0].name} / ${candidates[0].profileName}`;
  }
  if (sourceIsCurrentProfile(profileDir)) {
    throw new Error("browser sync source must be separate from the ego lite profile");
  }
  browserSyncConfig = normalizeBrowserSyncConfig({
    ...browserSyncConfig,
    sourceProfileDir: profileDir,
    sourceName,
  });
  writeBrowserSyncConfig();
  publishBrowserState();
  return currentBrowserSync();
}

browserSyncConfig = readBrowserSyncConfig();
browserSyncState = {
  ...browserSyncState,
  status: browserSyncConfig.enabled ? "idle" : "disabled",
  lastSyncAt: browserSyncConfig.lastSyncAt,
};

function writeHistory() {
  const temporaryPath = `${HISTORY_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(historyDocument(historyEntries), null, 2)}\n`);
  renameSync(temporaryPath, HISTORY_PATH);
}

function currentHistory() {
  return historyEntries.map((entry) => ({ ...entry }));
}

function recordViewHistory(view) {
  const managed = [...managedViews.values()].find(
    (candidate) => candidate.view === view,
  );
  if (!managed || managed.private) return;
  const url = view.webContents.getURL();
  const next = recordHistory(historyEntries, {
    url,
    title: view.webContents.getTitle(),
    visitedAt: new Date().toISOString(),
  });
  if (JSON.stringify(next) === JSON.stringify(historyEntries)) return;
  historyEntries = next;
  writeHistory();
  publishBrowserState();
}

function readReadingList() {
  try {
    return readReadingListDocument(
      JSON.parse(readFileSync(READING_LIST_PATH, "utf8")),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read reading list: ${error?.message || String(error)}`,
      );
    }
    return [];
  }
}

function writeReadingList() {
  const temporaryPath = `${READING_LIST_PATH}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(readingListDocument(readingListEntries), null, 2)}\n`,
  );
  renameSync(temporaryPath, READING_LIST_PATH);
}

function currentReadingList() {
  return readingListEntries.map((entry) => ({ ...entry }));
}

function activeReadingListTarget() {
  return [...managedViews.values()].find(
    (candidate) => candidate.view === browserView,
  );
}

function readingListCanAdd() {
  const active = activeReadingListTarget();
  return Boolean(
    active &&
      !active.private &&
      /^https?:\/\//i.test(active.view.webContents.getURL()),
  );
}

function addCurrentToReadingList() {
  const active = activeReadingListTarget();
  if (!active) throw new Error("active tab not found");
  if (active.private) throw new Error("private tabs cannot use the reading list");
  const url = active.view.webContents.getURL();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("reading list requires an HTTP(S) page");
  }
  readingListEntries = addReadingListEntry(readingListEntries, {
    url,
    title: active.view.webContents.getTitle(),
    addedAt: new Date().toISOString(),
  });
  writeReadingList();
  publishBrowserState();
  return currentBrowserState();
}

function removeFromReadingList(url) {
  readingListEntries = removeReadingListEntry(readingListEntries, url);
  writeReadingList();
  publishBrowserState();
  return currentBrowserState();
}

function boundedWindowDimension(value, minimum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.round(number));
}

function windowPositionIsVisible({ x, y, width, height }) {
  try {
    return screen.getAllDisplays().some(({ workArea }) => {
      const horizontalOverlap = Math.max(
        0,
        Math.min(x + width, workArea.x + workArea.width) -
          Math.max(x, workArea.x),
      );
      const verticalOverlap = Math.max(
        0,
        Math.min(y + height, workArea.y + workArea.height) -
          Math.max(y, workArea.y),
      );
      return horizontalOverlap >= 80 && verticalOverlap >= 80;
    });
  } catch {
    return false;
  }
}

function readWindowState() {
  let stored;
  try {
    stored = JSON.parse(readFileSync(WINDOW_STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read window state: ${error?.message || String(error)}`,
      );
    }
    return null;
  }
  if (stored?.version !== 1) return null;

  const state = {
    width: boundedWindowDimension(
      stored.width,
      WINDOW_MIN_WIDTH,
      WINDOW_DEFAULT_WIDTH,
    ),
    height: boundedWindowDimension(
      stored.height,
      WINDOW_MIN_HEIGHT,
      WINDOW_DEFAULT_HEIGHT,
    ),
    maximized: Boolean(stored.maximized),
  };
  const x = Number(stored.x);
  const y = Number(stored.y);
  if (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    windowPositionIsVisible({
      x,
      y,
      width: state.width,
      height: state.height,
    })
  ) {
    state.x = Math.round(x);
    state.y = Math.round(y);
  }
  return state;
}

function currentWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const bounds = mainWindow.getNormalBounds();
  return {
    version: 1,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  };
}

function saveWindowStateSync() {
  const state = currentWindowState();
  if (!state) return;
  const temporaryPath = `${WINDOW_STATE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(WINDOW_STATE_PATH), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporaryPath, WINDOW_STATE_PATH);
  } catch (error) {
    console.warn(
      `[ego-lite] could not flush window state: ${error?.message || String(error)}`,
    );
  }
}

function scheduleWindowStateSave() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = undefined;
    saveWindowStateSync();
  }, 100);
}

function readProfileRegistry() {
  const fallback = [
    {
      id: "default",
      name: "Personal",
      createdAt: null,
      lastUsedAt: null,
    },
  ];
  if (!PROFILE_MANAGER_ENABLED) return fallback;
  let stored;
  try {
    stored = JSON.parse(readFileSync(PROFILE_REGISTRY_PATH, "utf8"));
  } catch {
    stored = null;
  }
  const profiles = new Map();
  for (const profile of Array.isArray(stored?.profiles)
    ? stored.profiles
    : []) {
    const id = validProfileId(profile?.id);
    if (id !== profile?.id || profiles.has(id)) continue;
    profiles.set(id, {
      id,
      name: String(profile.name || id).trim().slice(0, 80) || id,
      createdAt: profile.createdAt || null,
      lastUsedAt: profile.lastUsedAt || null,
    });
  }
  if (!profiles.has("default")) profiles.set("default", fallback[0]);
  if (!profiles.has(ACTIVE_PROFILE_ID)) {
    profiles.set(ACTIVE_PROFILE_ID, {
      id: ACTIVE_PROFILE_ID,
      name: ACTIVE_PROFILE_ID,
      createdAt: null,
      lastUsedAt: null,
    });
  }
  return [...profiles.values()].sort((left, right) => {
    if (left.id === "default") return -1;
    if (right.id === "default") return 1;
    return String(left.name).localeCompare(String(right.name));
  });
}

function writeProfileRegistry(profiles) {
  mkdirSync(dirname(PROFILE_REGISTRY_PATH), { recursive: true });
  const temporaryPath = `${PROFILE_REGISTRY_PATH}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
  );
  renameSync(temporaryPath, PROFILE_REGISTRY_PATH);
}

function profileSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return validProfileId(slug === "default" ? "profile" : slug);
}

function currentProfiles() {
  if (!PROFILE_MANAGER_ENABLED) return [];
  return readProfileRegistry().map((profile) => ({
    ...profile,
    active: profile.id === ACTIVE_PROFILE_ID,
  }));
}

function relaunchArgumentsForProfile(profileId) {
  const args = [];
  for (let index = 1; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--profile") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) continue;
    args.push(argument);
  }
  args.push("--profile", profileId);
  return args;
}

function relaunchForProfile(profileId) {
  if (!PROFILE_MANAGER_ENABLED) {
    throw new Error("profile switching is unavailable for a custom profile");
  }
  const profiles = readProfileRegistry();
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error(`profile not found: ${profileId}`);
  }
  const updatedProfiles = profiles.map((profile) =>
    profile.id === profileId
      ? { ...profile, lastUsedAt: new Date().toISOString() }
      : profile,
  );
  writeProfileRegistry(updatedProfiles);
  saveWindowStateSync();
  savePrimarySessionSync();
  saveSpaceSessionSync();
  app.relaunch({ args: relaunchArgumentsForProfile(profileId) });
  app.exit(0);
  return { restarting: true, profileId };
}

function createProfile({ name }) {
  if (!PROFILE_MANAGER_ENABLED) {
    throw new Error("profile creation is unavailable for a custom profile");
  }
  const label = String(name || "").trim().slice(0, 80);
  if (!label) throw new Error("profile name is required");
  const profiles = readProfileRegistry();
  const existingIds = new Set(profiles.map((profile) => profile.id));
  const baseId = profileSlug(label);
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) id = `${baseId}-${suffix++}`;
  const profile = {
    id,
    name: label,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  writeProfileRegistry([...profiles, profile]);
  return relaunchForProfile(id);
}

function managedTabState() {
  return [...managedViews.entries()].map(([targetId, managed]) => ({
    targetId,
    spaceId: managed.spaceId,
    spaceName: managed.spaceName || null,
    private: Boolean(managed.private),
    muted: managed.view.webContents.isAudioMuted(),
    devtoolsOpen: managed.view.webContents.isDevToolsOpened(),
    url: managed.view.webContents.getURL() || "about:blank",
    title: managed.view.webContents.getTitle() || "",
    tabGroup: managed.tabGroup || null,
    active: managed.view === browserView,
  }));
}

function currentDownloads() {
  return [...downloadStates.values()]
    .slice(-20)
    .reverse()
    .map((download) => ({ ...download }));
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function downloadProgress(item) {
  const receivedBytes = nonNegativeNumber(item.getReceivedBytes());
  const totalBytes = nonNegativeNumber(item.getTotalBytes());
  const percent =
    receivedBytes !== null && totalBytes > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((receivedBytes / totalBytes) * 100)),
        )
      : null;
  return { receivedBytes, totalBytes, percent };
}

function installDownloadHandlers(webSession) {
  if (downloadSessions.has(webSession)) return;
  downloadSessions.add(webSession);
  webSession.on("will-download", (_event, item, webContents) => {
    const managed = [...managedViews.values()].find(
      (candidate) => candidate.view.webContents === webContents,
    );
    const id = randomUUID();
    const filename = basename(item.getFilename() || "download") || "download";
    const download = {
      id,
      filename,
      url: item.getURL() || "",
      state: "progressing",
      ...downloadProgress(item),
      path: null,
      spaceId: managed?.spaceId ?? null,
      spaceName: managed?.spaceName || null,
      private: Boolean(managed?.private),
    };
    downloadStates.set(id, download);
    while (downloadStates.size > 20) {
      const oldest = downloadStates.keys().next().value;
      if (!oldest) break;
      downloadStates.delete(oldest);
    }

    if (managed?.spaceId === null || !managed) {
      mkdirSync(DOWNLOAD_DIR, { recursive: true });
      if (!item.getSavePath()) item.setSavePath(join(DOWNLOAD_DIR, filename));
    }

    const publishDownload = (state) => {
      const current = downloadStates.get(id);
      if (!current) return;
      downloadStates.set(id, {
        ...current,
        state,
        ...downloadProgress(item),
        path: item.getSavePath() || current.path,
      });
      publishBrowserState();
    };
    item.on("updated", (_event, state) => publishDownload(state));
    item.once("done", (_event, state) => publishDownload(state));
    publishBrowserState();
  });
}

function readTaskSpaceState() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (state?.version === 1 && Array.isArray(state.spaces)) return state;
  } catch {
    // The SDK may not have created its state file yet.
  }
  return { version: 1, nextId: 1, spaces: [] };
}

function writeTaskSpaceState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, STATE_PATH);
}

function currentTaskSpaces() {
  return readTaskSpaceState().spaces.map((space) => ({
    id: Number(space.id),
    taskId: space.taskId || null,
    name: space.name || `Space ${space.id}`,
    ownership: space.ownership === "user" ? "user" : "agent",
    createdAt: space.createdAt || null,
    tabCount: [...managedViews.values()].filter(
      (managed) => managed.spaceId === Number(space.id),
    ).length,
    taskState: agentTaskStates.get(Number(space.id)) || null,
    running: agentTaskStates.has(Number(space.id)),
  }));
}

function currentControlState() {
  const active = [...managedViews.values()].find(
    (managed) => managed.view === browserView,
  );
  if (!active || active.spaceId === null) {
    return {
      scope: "primary",
      ownership: "user",
      label: "Your tab",
    };
  }
  const space = readTaskSpaceState().spaces.find(
    (candidate) => candidate.id === active.spaceId,
  );
  const ownership = space?.ownership === "user" ? "user" : "agent";
  return {
    scope: "space",
    spaceId: active.spaceId,
    spaceName: active.spaceName || space?.name || null,
    ownership,
    label: ownership === "user" ? "User control" : "Agent control",
  };
}

function currentBrowserState() {
  const active = managedRecordForView(browserView);
  const activeTaskState =
    active?.spaceId === null || active?.spaceId === undefined
      ? null
      : agentTaskStates.get(active.spaceId) || null;
  return {
    title: browserView?.webContents.getTitle() || "ego lite",
    url: browserView?.webContents.getURL() || "about:blank",
    profileId: ACTIVE_PROFILE_ID,
    serverName: SERVER_NAME,
    fullscreen: Boolean(mainWindow?.isFullScreen()),
    ...currentBookmarkState(),
    canReopenClosedTab: closedPrimaryTabs.length > 0,
    profiles: currentProfiles(),
    agentTaskState: activeTaskState,
    controlState: currentControlState(),
    bookmarks,
    history: currentHistory(),
    readingList: currentReadingList(),
    readingListCanAdd: readingListCanAdd(),
    browserSync: currentBrowserSync(),
    downloads: currentDownloads(),
    extensions: currentExtensions(),
    taskSpaces: currentTaskSpaces(),
    updateState: { ...updateState },
    canGoBack: browserView?.webContents.navigationHistory.canGoBack() || false,
    canGoForward:
      browserView?.webContents.navigationHistory.canGoForward() || false,
    tabs: managedTabState(),
  };
}

function sessionTabUrl(value) {
  try {
    const url = new URL(String(value || "about:blank"));
    if (url.toString() === WELCOME_URL) return "about:blank";
    if (url.protocol === "about:") {
      return url.toString() === "about:blank" ? url.toString() : null;
    }
    return ["file:", "http:", "https:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function primaryManagedViews() {
  return [...managedViews.entries()].filter(
    ([, managed]) => managed.spaceId === null,
  );
}

function persistentPrimaryManagedViews() {
  return primaryManagedViews().filter(([, managed]) => !managed.private);
}

function primarySessionManifest() {
  const persistentTabs = persistentPrimaryManagedViews();
  const tabs = persistentTabs
    .map(([targetId, managed], index) => {
      const url = sessionTabUrl(managed.view.webContents.getURL());
      if (!url) return null;
      return {
        targetId,
        url,
        index,
        active: managed.view === browserView,
        groupId: managed.tabGroup?.id || null,
      };
    })
    .filter(Boolean);
  const groups = new Map();
  for (const [, managed] of persistentTabs) {
    const group = managed.tabGroup;
    if (!group || groups.has(group.id)) continue;
    groups.set(group.id, {
      id: group.id,
      title: String(group.title || "").slice(0, 120),
      color: String(group.color || "grey"),
      collapsed: Boolean(group.collapsed),
    });
  }
  return {
    version: 1,
    tabs,
    groups: [...groups.values()],
  };
}

async function savePrimarySession() {
  if (!browserView) return;
  const temporaryPath = `${PRIMARY_SESSION_PATH}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(primarySessionManifest(), null, 2)}\n`,
  );
  await rename(temporaryPath, PRIMARY_SESSION_PATH);
}

function savePrimarySessionSync() {
  if (!browserView) return;
  const temporaryPath = `${PRIMARY_SESSION_PATH}.${process.pid}.sync.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(primarySessionManifest(), null, 2)}\n`,
    );
    renameSync(temporaryPath, PRIMARY_SESSION_PATH);
  } catch (error) {
    console.warn(
      `[ego-lite] could not flush primary tabs: ${error?.message || String(error)}`,
    );
  }
}

function spaceSessionManifest() {
  const spaces = new Map();
  for (const [, managed] of managedViews) {
    if (managed.spaceId === null || managed.view.webContents.isDestroyed()) {
      continue;
    }
    const url = sessionTabUrl(managed.view.webContents.getURL());
    if (!url) continue;
    let space = spaces.get(managed.spaceId);
    if (!space) {
      space = {
        id: managed.spaceId,
        name: managed.spaceName || null,
        tabs: [],
      };
      spaces.set(managed.spaceId, space);
    }
    space.tabs.push({
      url,
      active: managed.view === browserView,
    });
  }
  return { version: 1, spaces: [...spaces.values()] };
}

async function saveSpaceSession() {
  const temporaryPath = `${SPACE_SESSION_PATH}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(spaceSessionManifest(), null, 2)}\n`,
  );
  await rename(temporaryPath, SPACE_SESSION_PATH);
}

function saveSpaceSessionSync() {
  const temporaryPath = `${SPACE_SESSION_PATH}.${process.pid}.sync.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(spaceSessionManifest(), null, 2)}\n`,
    );
    renameSync(temporaryPath, SPACE_SESSION_PATH);
  } catch (error) {
    console.warn(
      `[ego-lite] could not flush task-space tabs: ${error?.message || String(error)}`,
    );
  }
}

function scheduleSpaceSessionSave() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (spaceSaveTimer) clearTimeout(spaceSaveTimer);
  spaceSaveTimer = setTimeout(() => {
    spaceSaveTimer = undefined;
    void saveSpaceSession().catch((error) => {
      console.warn(
        `[ego-lite] could not persist task-space tabs: ${error?.message || String(error)}`,
      );
    });
  }, 100);
}

function schedulePrimarySessionSave() {
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = undefined;
    void savePrimarySession().catch((error) => {
      console.warn(
        `[ego-lite] could not persist primary tabs: ${error?.message || String(error)}`,
      );
    });
  }, 100);
}

function publishBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
  mainWindow.webContents.send("ego-lite:browser-state", currentBrowserState());
  schedulePrimarySessionSave();
  scheduleSpaceSessionSave();
}

function resizeBrowserView() {
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
  const { width, height } = mainWindow.getContentBounds();
  browserView.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT + TAB_STRIP_HEIGHT,
    width: Math.max(1, width),
    height: Math.max(1, height - TOOLBAR_HEIGHT - TAB_STRIP_HEIGHT),
  });
}

function setActiveBrowserView(view) {
  if (!mainWindow || mainWindow.isDestroyed() || !view) return;
  if (browserView === view) {
    resizeBrowserView();
    publishBrowserState();
    return;
  }
  browserView = view;
  mainWindow.setBrowserView(view);
  resizeBrowserView();
  view.webContents.focus();
  publishBrowserState();
}

async function targetIdForView(view) {
  const debuggerSession = view.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debuggerSession.isAttached()) {
      debuggerSession.attach("1.3");
      attachedHere = true;
    }
    const result = await debuggerSession.sendCommand("Target.getTargetInfo");
    return result.targetInfo.targetId;
  } finally {
    if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach();
  }
}

function toggleDevTools(view) {
  if (!view || view.webContents.isDestroyed()) return false;
  if (view.webContents.isDevToolsOpened()) {
    view.webContents.closeDevTools();
  } else {
    view.webContents.openDevTools({ mode: "detach" });
  }
  return true;
}

function installViewListeners(view) {
  for (const eventName of [
    "did-finish-load",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "devtools-opened",
    "devtools-closed",
  ]) {
    view.webContents.on(eventName, publishBrowserState);
  }
  view.webContents.on("found-in-page", (_event, result) => {
    if (view !== browserView || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("ego-lite:find-result", {
      activeMatchOrdinal: Number(result?.activeMatchOrdinal) || 0,
      matches: Number(result?.matches) || 0,
      finalUpdate: Boolean(result?.finalUpdate),
    });
  });
  for (const eventName of [
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
  ]) {
    view.webContents.on(eventName, () => recordViewHistory(view));
  }
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const rawKey = String(input.key || "");
    const normalizedKey = rawKey.toLowerCase();
    if (normalizedKey === "f12") {
      event.preventDefault();
      toggleDevTools(view);
      return;
    }
    if (rawKey.toLowerCase() === "f11") {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
      return;
    }
    if (
      (input.control && input.shift && normalizedKey === "i") ||
      (input.meta && input.alt && normalizedKey === "i")
    ) {
      event.preventDefault();
      toggleDevTools(view);
      return;
    }
    if (input.alt || !(input.control || input.meta)) return;
    const key = String(input.key || "").toLowerCase();
    if (input.control && input.meta && key === "f") {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
      return;
    }
    if (input.shift && key === "t") {
      event.preventDefault();
      void reopenClosedTab().catch((error) => {
        console.error(
          `[ego-lite] could not reopen closed tab: ${error?.message || String(error)}`,
        );
      });
      return;
    }
    if (!input.shift && key === "f") {
      event.preventDefault();
      mainWindow?.webContents.send("ego-lite:focus-find");
      return;
    }
    if (input.shift && key === "n") {
      event.preventDefault();
      void createUserTab({ privateMode: true }).catch((error) => {
        console.error(
          `[ego-lite] could not create private shortcut tab: ${error?.message || String(error)}`,
        );
      });
      return;
    }
    if (input.shift) return;
    if (key === "t") {
      event.preventDefault();
      void createUserTab().catch((error) => {
        console.error(
          `[ego-lite] could not create shortcut tab: ${error?.message || String(error)}`,
        );
      });
    } else if (key === "w") {
      event.preventDefault();
      void closeActiveTab().catch((error) => {
        console.error(
          `[ego-lite] could not close shortcut tab: ${error?.message || String(error)}`,
        );
      });
    } else if (key === "l") {
      event.preventDefault();
      mainWindow?.webContents.send("ego-lite:focus-address");
    } else if (key === "r") {
      event.preventDefault();
      browserView?.webContents.reload();
    } else if (key === "[") {
      event.preventDefault();
      if (browserView?.webContents.navigationHistory.canGoBack()) {
        browserView.webContents.navigationHistory.goBack();
      }
    } else if (key === "]") {
      event.preventDefault();
      if (browserView?.webContents.navigationHistory.canGoForward()) {
        browserView.webContents.navigationHistory.goForward();
      }
    }
  });
}

function enableAccessibility(view) {
  if (typeof view.webContents.setAccessibilitySupportEnabled === "function") {
    view.webContents.setAccessibilitySupportEnabled(true);
  }
}

function permissionOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return String(value || "");
  }
}

function permissionNames(permission) {
  return permissionAliases[permission] || [permission];
}

function permissionKey(origin, permission) {
  return `${permissionOrigin(origin)}\n${permission}`;
}

function installPermissionHandlers(webSession) {
  const existing = sessionPermissionStates.get(webSession);
  if (existing) return existing;

  const state = { rules: new Map() };
  sessionPermissionStates.set(webSession, state);
  webSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const origin =
        requestingOrigin || details?.requestingUrl || webContents?.getURL();
      return state.rules.get(permissionKey(origin, permission)) === "granted";
    },
  );
  webSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const origin = details?.requestingUrl || webContents?.getURL();
      callback(
        state.rules.get(permissionKey(origin, permission)) === "granted",
      );
    },
  );
  return state;
}

function updatePermissionRules(state, origin, permissions, setting) {
  for (const permission of permissions) {
    for (const name of permissionNames(permission)) {
      const key = permissionKey(origin, name);
      if (setting === "prompt") state.rules.delete(key);
      else state.rules.set(key, setting);
    }
  }
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  if (!domain) return null;
  const protocol = cookie.secure ? "https" : "http";
  const path = String(cookie.path || "/").startsWith("/")
    ? cookie.path
    : `/${cookie.path}`;
  return `${protocol}://${domain}${path}`;
}

async function inheritPrimaryCookies(targetSession) {
  if (targetSession === session.defaultSession) return;

  const [sourceCookies, targetCookies] = await Promise.all([
    session.defaultSession.cookies.get({}),
    targetSession.cookies.get({}),
  ]);
  if (sourceCookies.length === 0 || targetCookies.length > 0) return;

  let copied = 0;
  let failed = 0;
  for (const cookie of sourceCookies) {
    const url = cookieUrl(cookie);
    if (!url) continue;
    try {
      await targetSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.domain && !cookie.hostOnly ? { domain: cookie.domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
        ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
        ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
        ...(cookie.expirationDate
          ? { expirationDate: cookie.expirationDate }
          : {}),
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      });
      copied += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `[ego-lite] could not inherit cookie ${cookie.name}: ${error?.message || String(error)}`,
      );
    }
  }
  if (copied > 0 || failed > 0) {
    console.log(
      `[ego-lite] inherited ${copied} primary-session cookie(s) into task space${failed ? `; ${failed} failed` : ""}`,
    );
  }
}

function readDisabledExtensionIds() {
  try {
    const state = JSON.parse(readFileSync(EXTENSION_STATE_PATH, "utf8"));
    return state?.version === 1 && Array.isArray(state.disabled)
      ? new Set(
          state.disabled
            .filter((id) => typeof id === "string")
            .map((id) => id.trim())
            .filter(Boolean),
        )
      : new Set();
  } catch {
    return new Set();
  }
}

function writeDisabledExtensionIds(disabled) {
  const temporaryPath = `${EXTENSION_STATE_PATH}.${process.pid}.tmp`;
  mkdirSync(dirname(EXTENSION_STATE_PATH), { recursive: true });
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2)}\n`,
  );
  renameSync(temporaryPath, EXTENSION_STATE_PATH);
}

function extensionStateForId(states, id) {
  if (!states) return null;
  return (
    states.get(id) ||
    [...states.values()].find((extension) => extension.id === id) ||
    null
  );
}

function currentExtensions() {
  const states = sessionExtensionStates.get(session.defaultSession);
  return [...(states?.values() || [])].map(
    ({ id, name, version, enabled, error }) => ({
      id,
      name,
      version,
      enabled: Boolean(enabled),
      ...(error ? { error } : {}),
    }),
  );
}

async function loadMigratedExtensions(webSession) {
  const existing = sessionExtensionLoads.get(webSession);
  if (existing) return existing;

  const states = new Map();
  sessionExtensionStates.set(webSession, states);
  const loadPromise = (async () => {
    const extensionRoot = join(PROFILE_DIR, "Default", "Extensions");
    let extensionEntries;
    try {
      extensionEntries = await readdir(extensionRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      console.warn(
        `[ego-lite] could not inspect migrated extensions: ${error?.message || String(error)}`,
      );
      return [];
    }

    const disabled = readDisabledExtensionIds();
    const loaded = [];
    for (const extensionEntry of extensionEntries) {
      if (!extensionEntry.isDirectory()) continue;
      const extensionDir = join(extensionRoot, extensionEntry.name);
      let versionEntries;
      try {
        versionEntries = await readdir(extensionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const versions = versionEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true }),
        );
      let extensionState;
      for (const version of versions) {
        const extensionPath = join(extensionDir, version);
        let manifest;
        try {
          manifest = JSON.parse(
            await readFile(join(extensionPath, "manifest.json"), "utf8"),
          );
        } catch (error) {
          console.warn(
            `[ego-lite] could not read migrated extension ${extensionEntry.name}/${version}: ${error?.message || String(error)}`,
          );
          continue;
        }
        if (!Number.isInteger(manifest?.manifest_version)) continue;
        const candidate = {
          id: extensionEntry.name,
          name: manifest.name || extensionEntry.name,
          version: manifest.version || version,
          path: extensionPath,
        };
        extensionCatalog.set(candidate.id, candidate);
        if (disabled.has(candidate.id)) {
          extensionState = { ...candidate, enabled: false, error: null };
          break;
        }
        try {
          const details = await webSession.loadExtension(extensionPath, {
            allowFileAccess: true,
          });
          extensionState = {
            ...candidate,
            id: details.id || candidate.id,
            name: details.name || candidate.name,
            version: details.version || candidate.version,
            enabled: true,
            error: null,
          };
          extensionCatalog.set(extensionState.id, extensionState);
          loaded.push({
            id: extensionState.id,
            name: extensionState.name,
            version: extensionState.version,
          });
        } catch (error) {
          extensionState = {
            ...candidate,
            enabled: false,
            error: String(error?.message || error).slice(0, 240),
          };
          console.warn(
            `[ego-lite] could not load migrated extension ${extensionEntry.name}/${version}: ${error?.message || String(error)}`,
          );
        }
        if (extensionState?.enabled) break;
      }
      if (extensionState) states.set(extensionState.id, extensionState);
    }
    if (loaded.length > 0) {
      console.log(`[ego-lite] loaded ${loaded.length} migrated extension(s)`);
    }
    return loaded;
  })();
  sessionExtensionLoads.set(webSession, loadPromise);
  return loadPromise;
}

async function setExtensionEnabled({ id, enabled }) {
  const extensionId = String(id || "").trim();
  if (!extensionId) throw new Error("extension id is required");
  const requestedState = Boolean(enabled);
  const candidate =
    extensionCatalog.get(extensionId) ||
    extensionStateForId(
      sessionExtensionStates.get(session.defaultSession),
      extensionId,
    );
  if (!candidate) throw new Error(`extension not found: ${extensionId}`);

  const disabled = readDisabledExtensionIds();
  if (requestedState) disabled.delete(candidate.id);
  else disabled.add(candidate.id);
  writeDisabledExtensionIds(disabled);

  const sessions = new Set([session.defaultSession]);
  for (const managed of managedViews.values()) {
    if (!managed.private) sessions.add(managed.view.webContents.session);
  }
  try {
    for (const webSession of sessions) {
      const states = sessionExtensionStates.get(webSession);
      if (!states) continue;
      const current = extensionStateForId(states, candidate.id);
      if (requestedState) {
        if (current?.enabled) continue;
        const details = await webSession.loadExtension(
          current?.path || candidate.path,
          { allowFileAccess: true },
        );
        const next = {
          ...candidate,
          ...current,
          id: details.id || candidate.id,
          name: details.name || current?.name || candidate.name,
          version: details.version || current?.version || candidate.version,
          enabled: true,
          error: null,
        };
        if (current) states.delete(current.id);
        states.set(next.id, next);
        extensionCatalog.set(next.id, next);
      } else {
        if (current?.enabled) webSession.removeExtension(current.id);
        if (current) states.delete(current.id);
        states.set(candidate.id, {
          ...candidate,
          ...current,
          id: candidate.id,
          enabled: false,
          error: null,
        });
      }
    }
  } catch (error) {
    disabled.add(candidate.id);
    writeDisabledExtensionIds(disabled);
    throw error;
  }
  publishBrowserState();
  return currentBrowserState();
}

function applyPermissionCommand({ targetId, method, params = {} }) {
  const managed = managedViews.get(targetId);
  if (!managed) throw new Error(`Electron target not found: ${targetId}`);
  const state = installPermissionHandlers(managed.view.webContents.session);
  if (method === "Browser.resetPermissions") {
    state.rules.clear();
    return {};
  }

  const origin = params.origin;
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new Error(`${method} requires an origin`);
  }
  if (method === "Browser.grantPermissions") {
    if (!Array.isArray(params.permissions)) {
      throw new Error("Browser.grantPermissions requires permissions");
    }
    updatePermissionRules(state, origin, params.permissions, "granted");
    return {};
  }
  if (method === "Browser.setPermission") {
    const permission = params.permission?.name;
    const setting = params.setting;
    if (typeof permission !== "string" || !permission) {
      throw new Error("Browser.setPermission requires permission.name");
    }
    if (!["granted", "denied", "prompt"].includes(setting)) {
      throw new Error("Browser.setPermission requires a valid setting");
    }
    updatePermissionRules(state, origin, [permission], setting);
    return {};
  }
  throw new Error(`unsupported permission command: ${method}`);
}

async function registerManagedView(
  view,
  {
    spaceId = null,
    spaceName = null,
    tabId = null,
    tabGroup = null,
    privateMode = false,
  } = {},
) {
  installViewListeners(view);
  installPermissionHandlers(view.webContents.session);
  installDownloadHandlers(view.webContents.session);
  const targetId = await targetIdForView(view);
  managedViews.set(targetId, {
    view,
    spaceId,
    spaceName,
    tabId,
    tabGroup,
    private: privateMode,
  });
  publishBrowserState();
  return targetId;
}

function managedRecordForView(view) {
  return [...managedViews.values()].find(
    (candidate) => candidate.view === view,
  );
}

function shouldActivateOpenedTab(disposition) {
  return disposition !== "background-tab";
}

async function openWindowAsManagedTab(view, value, disposition) {
  const source = managedRecordForView(view);
  if (!source) return null;
  if (source.spaceId === null) {
    const primary = await createPrimaryBrowserView({
      url: value,
      privateMode: source.private,
    });
    if (shouldActivateOpenedTab(disposition)) {
      setActiveBrowserView(primary.view);
    }
    return primary.targetId;
  }
  const task = await createManagedView({
    spaceId: source.spaceId,
    spaceName: source.spaceName,
    url: value,
  });
  return task.targetId;
}

async function createManagedView({
  spaceId,
  spaceName = null,
  url = "about:blank",
}) {
  if (spaceId === null) {
    const primary = await createPrimaryBrowserView({ url });
    return { targetId: primary.targetId };
  }
  const partition = `persist:ego-lite-${String(spaceId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });
  view.webContents.setAudioMuted(true);
  enableAccessibility(view);
  installDownloadHandlers(view.webContents.session);
  await loadMigratedExtensions(view.webContents.session);
  await inheritPrimaryCookies(view.webContents.session);
  view.webContents.setWindowOpenHandler(({ url: openedUrl, disposition }) => {
    void openWindowAsManagedTab(view, openedUrl, disposition).catch((error) => {
      console.error(`[ego-lite] cannot open ${openedUrl}: ${error.message}`);
    });
    return { action: "deny" };
  });
  await view.webContents.loadURL(normalizeUrl(url));
  const targetId = await registerManagedView(view, { spaceId, spaceName });
  return { targetId };
}

async function navigateOnView(view, value) {
  const url = normalizeUrl(value);
  await view.webContents.loadURL(url);
  return url;
}

async function routeExternalTargets(
  values,
  { cwd = process.cwd(), commandLine = false } = {},
) {
  const targets = commandLine
    ? externalTargetsFromArguments(values, cwd)
    : values.map((value) => normalizeExternalTarget(value, cwd)).filter(Boolean);
  if (targets.length === 0) return [];
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) {
    pendingExternalTargets.push(...targets);
    return targets;
  }

  const opened = [];
  for (const target of targets) {
    const active = managedRecordForView(browserView);
    if (
      opened.length === 0 &&
      active?.spaceId === null &&
      !active.private &&
      browserView.webContents.getURL() === "about:blank"
    ) {
      await navigateOnView(browserView, target);
    } else {
      const primary = await createPrimaryBrowserView({ url: target });
      setActiveBrowserView(primary.view);
    }
    opened.push(target);
  }
  publishBrowserState();
  return opened;
}

async function closeManagedView(targetId) {
  const managed = managedViews.get(targetId);
  if (!managed) return { closed: false };
  const wasPrimary = managed.spaceId === null;
  const closedSpaceId = managed.spaceId;
  const wasActive = managed.view === browserView;
  const closedTabUrl =
    wasPrimary && !managed.private
      ? sessionTabUrl(managed.view.webContents.getURL())
      : null;
  const closedTabGroup =
    closedTabUrl && managed.tabGroup ? { ...managed.tabGroup } : null;
  if (closedTabUrl) {
    closedPrimaryTabs.push({ url: closedTabUrl, tabGroup: closedTabGroup });
    while (closedPrimaryTabs.length > 20) closedPrimaryTabs.shift();
  }
  managedViews.delete(targetId);
  if (wasActive) {
    const fallback =
      primaryManagedViews()[0]?.[1].view || [...managedViews.values()][0]?.view;
    browserView = fallback || null;
    if (fallback) setActiveBrowserView(fallback);
  }
  managed.view.webContents.close();
  if (closedSpaceId !== null) {
    const state = readTaskSpaceState();
    if (
      state.spaces.some((space) => space.id === closedSpaceId) &&
      ![...managedViews.values()].some(
        (candidate) => candidate.spaceId === closedSpaceId,
      )
    ) {
      state.spaces = state.spaces.filter(
        (space) => space.id !== closedSpaceId,
      );
      agentTaskStates.delete(closedSpaceId);
      writeTaskSpaceState(state);
    }
  }
  if (
    wasPrimary &&
    primaryManagedViews().length === 0 &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.close();
    return { closed: true, windowClosed: true };
  }
  publishBrowserState();
  return { closed: true };
}

async function createUserTab({ privateMode = false } = {}) {
  const primary = await createPrimaryBrowserView({
    url: "about:blank",
    tabId: `user-${randomUUID()}`,
    privateMode,
  });
  setActiveBrowserView(primary.view);
  return managedTabState();
}

async function reopenClosedTab() {
  const closed = closedPrimaryTabs.pop();
  if (!closed) return managedTabState();
  const primary = await createPrimaryBrowserView({
    url: closed.url,
    tabId: `user-${randomUUID()}`,
    tabGroup: closed.tabGroup,
  });
  setActiveBrowserView(primary.view);
  return managedTabState();
}

function setActiveTabMuted({ muted } = {}) {
  const managed = [...managedViews.values()].find(
    (candidate) => candidate.view === browserView,
  );
  if (!managed) throw new Error("active tab not found");
  const nextMuted =
    muted === undefined
      ? !managed.view.webContents.isAudioMuted()
      : Boolean(muted);
  managed.view.webContents.setAudioMuted(nextMuted);
  publishBrowserState();
  return currentBrowserState();
}

async function closeActiveTab() {
  const active = [...managedViews.entries()].find(
    ([, managed]) => managed.view === browserView,
  );
  if (!active) return managedTabState();
  await closeManagedView(active[0]);
  return managedTabState();
}

function requestedSpaceId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error("task Space id must be a non-negative integer");
  }
  return id;
}

function setTaskSpaceOwnership({ spaceId, ownership }) {
  const id = requestedSpaceId(spaceId);
  if (ownership !== "agent" && ownership !== "user") {
    throw new Error("task Space ownership must be agent or user");
  }
  const state = readTaskSpaceState();
  const space = state.spaces.find((candidate) => candidate.id === id);
  if (!space) throw new Error(`task Space not found: ${id}`);
  space.ownership = ownership;
  writeTaskSpaceState(state);
  publishBrowserState();
  return currentBrowserState();
}

async function stopTaskSpace({ spaceId }) {
  const id = requestedSpaceId(spaceId);
  const state = readTaskSpaceState();
  if (!state.spaces.some((space) => space.id === id)) {
    throw new Error(`task Space not found: ${id}`);
  }
  const targetIds = [...managedViews.entries()]
    .filter(([, managed]) => managed.spaceId === id)
    .map(([targetId]) => targetId);
  for (const targetId of targetIds) await closeManagedView(targetId);
  state.spaces = state.spaces.filter((space) => space.id !== id);
  writeTaskSpaceState(state);
  await saveSpaceSession();
  publishBrowserState();
  return currentBrowserState();
}

function managedViewForTarget(targetId) {
  if (targetId) return managedViews.get(targetId)?.view || null;
  return browserView || null;
}

function updateTabGroup({ id, collapsed }) {
  if (typeof id !== "string" || !id) {
    throw new Error("tab group id is required");
  }
  let updated = 0;
  for (const managed of managedViews.values()) {
    if (managed.spaceId !== null || managed.tabGroup?.id !== id) continue;
    managed.tabGroup = {
      ...managed.tabGroup,
      collapsed: Boolean(collapsed),
    };
    updated += 1;
  }
  if (updated === 0) throw new Error(`tab group not found: ${id}`);
  publishBrowserState();
  return managedTabState();
}

const TAB_GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

function normalizeTabGroupTitle(value) {
  return String(value || "New group").trim().slice(0, 80) || "New group";
}

function normalizeTabGroupColor(value) {
  const color = String(value || "grey").trim().toLowerCase();
  return TAB_GROUP_COLORS.has(color) ? color : "grey";
}

function setTabGroup({
  targetId = null,
  groupId = null,
  title,
  color,
  ungroup = false,
}) {
  const managed = targetId
    ? managedViews.get(String(targetId))
    : managedRecordForView(browserView);
  if (!managed) throw new Error("active tab not found");
  if (managed.spaceId !== null || managed.private) {
    throw new Error("tab groups are available only for normal tabs");
  }
  if (ungroup) {
    managed.tabGroup = null;
    publishBrowserState();
    return managedTabState();
  }

  let group = null;
  if (groupId) {
    group = [...managedViews.values()]
      .map((candidate) => candidate.tabGroup)
      .find((candidate) => candidate?.id === String(groupId));
    if (!group) throw new Error(`tab group not found: ${groupId}`);
  }
  managed.tabGroup = group
    ? { ...group }
    : {
        id: `group-${randomUUID()}`,
        title: normalizeTabGroupTitle(title),
        color: normalizeTabGroupColor(color),
        collapsed: false,
      };
  publishBrowserState();
  return managedTabState();
}

async function highlightAgentPointer({ targetId, x, y }) {
  const view = managedViewForTarget(targetId);
  const point = { x: Number(x), y: Number(y) };
  if (!view) return { highlighted: false };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("highlight requires finite x and y coordinates");
  }
  await view.webContents.executeJavaScript(
    `(() => {
    const previous = document.getElementById("ego-lite-agent-pointer-highlight");
    previous?.remove();
    const root = document.documentElement || document.body;
    if (!root) return false;
    const ring = document.createElement("div");
    ring.id = "ego-lite-agent-pointer-highlight";
    ring.setAttribute("aria-hidden", "true");
    Object.assign(ring.style, {
      position: "fixed",
      left: ${JSON.stringify(point.x)} + "px",
      top: ${JSON.stringify(point.y)} + "px",
      width: "28px",
      height: "28px",
      border: "3px solid rgba(96, 165, 250, 0.95)",
      borderRadius: "50%",
      boxShadow: "0 0 0 4px rgba(96, 165, 250, 0.22)",
      pointerEvents: "none",
      zIndex: "2147483647",
      transform: "translate(-50%, -50%) scale(0.7)",
      opacity: "1",
      transition: "transform 650ms ease-out, opacity 650ms ease-out",
    });
    root.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = "translate(-50%, -50%) scale(1.55)";
      ring.style.opacity = "0";
    });
    setTimeout(() => ring.remove(), 700);
    return true;
  })()`,
    true,
  );
  return { highlighted: true };
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function handleBridgeRequest(pathname, body) {
  if (pathname === "/health") return { ok: true };
  if (pathname === "/agent-state") {
    const value = body.label == null ? "" : String(body.label).trim();
    const normalized = value ? value.slice(0, 120) : null;
    const rawSpaceId = body.spaceId;
    const spaceId =
      rawSpaceId === null || rawSpaceId === undefined
        ? null
        : Number(rawSpaceId);
    if (Number.isInteger(spaceId) && spaceId >= 0) {
      if (normalized) agentTaskStates.set(spaceId, normalized);
      else agentTaskStates.delete(spaceId);
    }
    publishBrowserState();
    return {
      agentTaskState: normalized,
      spaceId: Number.isInteger(spaceId) && spaceId >= 0 ? spaceId : null,
      taskState: normalized,
    };
  }
  if (pathname === "/update-state") {
    return { updateState: { ...updateState } };
  }
  if (pathname === "/highlight") return highlightAgentPointer(body);
  if (pathname === "/create-tab") return createManagedView(body);
  if (pathname === "/activate-tab") {
    const managed = managedViews.get(body.targetId);
    if (!managed)
      throw new Error(`Electron target not found: ${body.targetId}`);
    setActiveBrowserView(managed.view);
    return { activated: true };
  }
  if (pathname === "/close-tab") return closeManagedView(body.targetId);
  if (pathname === "/permissions") return applyPermissionCommand(body);
  if (pathname === "/tabs") {
    return { tabs: managedTabState() };
  }
  throw new Error(`unknown Electron bridge path: ${pathname}`);
}

async function startBridge() {
  bridgeToken = randomUUID();
  bridgeServer = createServer(async (request, response) => {
    if (request.headers["x-ego-lite-token"] !== bridgeToken) {
      jsonResponse(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const payload = await handleBridgeRequest(
        new URL(request.url, "http://127.0.0.1").pathname,
        await requestBody(request),
      );
      jsonResponse(response, 200, payload);
    } catch (error) {
      jsonResponse(response, 400, {
        error: error?.message || String(error),
      });
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    bridgeServer.once("error", rejectPromise);
    bridgeServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = bridgeServer.address();
  await writeFile(
    bridgeFile,
    `${JSON.stringify({
      port: address.port,
      token: bridgeToken,
      pid: process.pid,
      profileId: ACTIVE_PROFILE_ID,
      serverName: SERVER_NAME,
    })}\n`,
  );
  if (!browserStateSyncTimer) {
    browserStateSyncTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
      mainWindow.webContents.send(
        "ego-lite:browser-state",
        currentBrowserState(),
      );
    }, 500);
  }
}

async function startAutoUpdater() {
  const enabled =
    app.isPackaged &&
    !CLI_MODE &&
    process.env.EGO_LITE_DISABLE_AUTO_UPDATE !== "1";
  if (!enabled) {
    updateState = {
      ...updateState,
      status: "disabled",
      message: null,
    };
    return;
  }

  try {
    // Keep the updater import lazy so CLI/dev launches do not load its provider
    // or attempt a network check.
    const { autoUpdater } = await import("electron-updater");
    updateController = createUpdateController({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      onState: (next) => {
        updateState = next;
        publishBrowserState();
      },
    });
    void updateController.start().catch((error) => {
      updateState = {
        ...updateState,
        status: "error",
        message: String(error?.message || error || "update check failed").slice(
          0,
          240,
        ),
      };
      publishBrowserState();
    });
  } catch (error) {
    updateState = {
      ...updateState,
      status: "error",
      message: String(error?.message || error || "updater unavailable").slice(
        0,
        240,
      ),
    };
    publishBrowserState();
  }
}

async function navigate(value) {
  const active = managedRecordForView(browserView);
  if (!active || active.spaceId === null) {
    return navigateOnView(browserView, value);
  }
  const primary = await createPrimaryBrowserView({ url: value });
  setActiveBrowserView(primary.view);
  return normalizeUrl(value);
}

function storedTabUrl(value, { migration = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (migration) {
      return ["http:", "https:"].includes(url.protocol)
        ? url.toString()
        : null;
    }
    return sessionTabUrl(url.toString());
  } catch {
    return null;
  }
}

async function readStoredTabsManifest(manifestPath, { migration = false } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read stored tab manifest: ${error?.message || String(error)}`,
      );
    }
    return null;
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.tabs)) {
    console.warn("[ego-lite] ignoring an unsupported migrated tab manifest");
    return null;
  }
  const groups = new Map(
    (Array.isArray(manifest.groups) ? manifest.groups : [])
      .filter((group) => group && typeof group.id === "string")
      .map((group) => [
        group.id,
        {
          id: group.id,
          title: String(group.title || "").slice(0, 120),
          color: String(group.color || "grey"),
          collapsed: Boolean(group.collapsed),
        },
      ]),
  );
  const tabs = manifest.tabs
    .map((tab) => {
      const url = storedTabUrl(tab?.url, { migration });
      if (!url) return null;
      const group = groups.get(tab?.groupId) || null;
      return {
        url,
        active: Boolean(tab.active),
        tabGroup: group,
      };
    })
    .filter(Boolean);
  return { manifestPath, tabs };
}

async function readMigratedTabsManifest() {
  return readStoredTabsManifest(join(PROFILE_DIR, MIGRATED_TABS_FILE), {
    migration: true,
  });
}

async function readPrimarySessionManifest() {
  return readStoredTabsManifest(PRIMARY_SESSION_PATH);
}

async function shouldShowWelcome({ restoredTabs, migrated, externalTargets = [] }) {
  if (process.env.EGO_LITE_DISABLE_WELCOME === "1") return false;
  const explicitlyRequested = process.env.EGO_LITE_SHOW_WELCOME === "1";
  if (externalTargets.length > 0 && !explicitlyRequested) return false;
  if (!app.isPackaged && !explicitlyRequested) return false;
  if (!explicitlyRequested && process.env.EGO_LITE_SKIP_MIGRATION === "1") {
    return false;
  }
  if (migrated || restoredTabs.length > 0) return false;
  try {
    await readFile(WELCOME_MARKER, "utf8");
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  if (await profileLooksUsable(join(PROFILE_DIR, "Default"))) return false;
  return true;
}

function markWelcomeSeen() {
  try {
    writeFileSync(WELCOME_MARKER, `${new Date().toISOString()}\n`);
  } catch (error) {
    console.warn(
      `[ego-lite] could not save welcome state: ${error?.message || String(error)}`,
    );
  }
}

async function readSpaceSessionManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(SPACE_SESSION_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read task-space session: ${error?.message || String(error)}`,
      );
    }
    return null;
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.spaces)) {
    console.warn("[ego-lite] ignoring an unsupported task-space session");
    return null;
  }
  const spaces = manifest.spaces
    .filter((space) => Number.isFinite(space?.id))
    .map((space) => ({
      id: Number(space.id),
      name: space.name ? String(space.name).slice(0, 120) : null,
      tabs: (Array.isArray(space.tabs) ? space.tabs : [])
        .map((tab) => ({
          url: sessionTabUrl(tab?.url),
          active: Boolean(tab?.active),
        }))
        .filter((tab) => tab.url),
    }));
  return { spaces };
}

async function writePendingProfileImport(sourcePath) {
  const temporaryPath = `${PENDING_IMPORT_PATH}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, sourcePath, requestedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  await rename(temporaryPath, PENDING_IMPORT_PATH);
}

async function takePendingProfileImport() {
  let request;
  try {
    request = JSON.parse(await readFile(PENDING_IMPORT_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        `[ego-lite] could not read pending profile import: ${error?.message || String(error)}`,
      );
    }
    return null;
  }
  await unlink(PENDING_IMPORT_PATH).catch(() => {});
  if (request?.version !== 1 || typeof request.sourcePath !== "string") {
    console.warn("[ego-lite] ignoring an unsupported pending profile import");
    return null;
  }
  const rawSourcePath = request.sourcePath.trim();
  if (!rawSourcePath) return null;
  const sourcePath = resolve(rawSourcePath);
  return { sourcePath };
}

async function createPrimaryBrowserView({
  url = "about:blank",
  tabId = null,
  tabGroup = null,
  privateMode = false,
} = {}) {
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    ...(privateMode
      ? { partition: `temp:ego-lite-private-${randomUUID()}` }
      : {}),
  };
  const view = new BrowserView({
    webPreferences,
  });
  enableAccessibility(view);
  installDownloadHandlers(view.webContents.session);
  view.webContents.setWindowOpenHandler(({ url: openedUrl, disposition }) => {
    void openWindowAsManagedTab(view, openedUrl, disposition).catch((error) => {
      console.error(`[ego-lite] cannot open ${openedUrl}: ${error.message}`);
    });
    return { action: "deny" };
  });
  if (!privateMode) await loadMigratedExtensions(view.webContents.session);
  try {
    await view.webContents.loadURL(normalizeUrl(url));
  } catch (error) {
    console.warn(
      `[ego-lite] could not restore ${url}: ${error?.message || String(error)}`,
    );
    await view.webContents.loadURL("about:blank");
  }
  const targetId = await registerManagedView(view, {
    tabId,
    tabGroup,
    privateMode,
  });
  return { view, targetId };
}

async function createWindow() {
  bookmarks = readBookmarks(join(PROFILE_DIR, "Default", "Bookmarks"));
  historyEntries = readHistory();
  readingListEntries = readReadingList();
  const migrated = await readMigratedTabsManifest();
  const persisted = migrated ? null : await readPrimarySessionManifest();
  const persistedSpaces = await readSpaceSessionManifest();
  const windowState = readWindowState();
  const stored = migrated || persisted;
  const restoredTabs = stored?.tabs || [];
  const showWelcome = await shouldShowWelcome({
    restoredTabs,
    migrated,
    externalTargets: pendingExternalTargets,
  });
  if (showWelcome) markWelcomeSeen();
  mainWindow = new BrowserWindow({
    width: windowState?.width || WINDOW_DEFAULT_WIDTH,
    height: windowState?.height || WINDOW_DEFAULT_HEIGHT,
    ...(windowState?.x !== undefined ? { x: windowState.x } : {}),
    ...(windowState?.y !== undefined ? { y: windowState.y } : {}),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: "ego lite",
    backgroundColor: "#111827",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The local toolbar uses the ESM preload bridge; remote page content is
      // hosted in separate BrowserViews with no preload access.
      sandbox: false,
      preload: join(MAIN_DIR, "preload.mjs"),
    },
  });
  if (windowState?.maximized) mainWindow.maximize();

  const firstTab = restoredTabs[0] || {
    url: showWelcome ? WELCOME_URL : "about:blank",
    tabGroup: null,
    active: true,
  };
  const restoredViews = [
    await createPrimaryBrowserView({
      url: firstTab.url,
      tabId: restoredTabs.length ? "migrated-0" : "default",
      tabGroup: firstTab.tabGroup,
    }),
  ];
  for (let index = 1; index < restoredTabs.length; index += 1) {
    const tab = restoredTabs[index];
    restoredViews.push(
      await createPrimaryBrowserView({
        url: tab.url,
        tabId: `migrated-${index}`,
        tabGroup: tab.tabGroup,
      }),
    );
  }
  browserView = restoredViews[0].view;
  mainWindow.setBrowserView(browserView);
  resizeBrowserView();
  mainWindow.on("resize", () => {
    resizeBrowserView();
    scheduleWindowStateSave();
  });
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("maximize", scheduleWindowStateSave);
  mainWindow.on("unmaximize", scheduleWindowStateSave);
  mainWindow.on("enter-full-screen", publishBrowserState);
  mainWindow.on("leave-full-screen", publishBrowserState);
  mainWindow.on("close", saveWindowStateSync);
  mainWindow.on("closed", () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = undefined;
    browserView = null;
    mainWindow = null;
  });

  const activeIndex = restoredTabs.findIndex((tab) => tab.active);
  if (activeIndex > 0) {
    setActiveBrowserView(restoredViews[activeIndex].view);
  }
  for (const space of persistedSpaces?.spaces || []) {
    for (const tab of space.tabs) {
      try {
        await createManagedView({
          spaceId: space.id,
          spaceName: space.name,
          url: tab.url,
        });
      } catch (error) {
        console.warn(
          `[ego-lite] could not restore task-space tab ${space.id}: ${error?.message || String(error)}`,
        );
      }
    }
  }
  if (migrated?.manifestPath) {
    await unlink(migrated.manifestPath).catch(() => {});
  }
  await savePrimarySession().catch((error) => {
    console.warn(
      `[ego-lite] could not persist initial primary tabs: ${error?.message || String(error)}`,
    );
  });
  await saveSpaceSession().catch((error) => {
    console.warn(
      `[ego-lite] could not persist initial task-space tabs: ${error?.message || String(error)}`,
    );
  });
  void mainWindow.loadFile(join(MAIN_DIR, "renderer", "index.html"));
}

function hostResourcePath() {
  return app.isPackaged
    ? join(process.resourcesPath, "ego-lite", "linux", "ego-browser.mjs")
    : resolve(MAIN_DIR, "..", "linux", "ego-browser.mjs");
}

async function runHostCommand(args) {
  const hostPath = hostResourcePath();
  const previousProfileDir = process.env.EGO_LITE_PROFILE_DIR;
  const previousStatePath = process.env.EGO_LITE_STATE_PATH;
  const previousProfileId = process.env.EGO_LITE_PROFILE_ID;
  const previousServerName = process.env.EGO_LITE_SERVER_NAME;
  if (previousProfileDir === undefined) {
    process.env.EGO_LITE_PROFILE_DIR = PROFILE_DIR;
  }
  if (previousStatePath === undefined) {
    process.env.EGO_LITE_STATE_PATH = STATE_PATH;
  }
  if (previousProfileId === undefined) {
    process.env.EGO_LITE_PROFILE_ID = ACTIVE_PROFILE_ID;
  }
  if (previousServerName === undefined) {
    process.env.EGO_LITE_SERVER_NAME = SERVER_NAME;
  }
  try {
    const { runHost } = await import(pathToFileURL(hostPath).href);
    return await runHost(args);
  } finally {
    if (previousProfileDir === undefined) {
      delete process.env.EGO_LITE_PROFILE_DIR;
    } else {
      process.env.EGO_LITE_PROFILE_DIR = previousProfileDir;
    }
    if (previousStatePath === undefined) {
      delete process.env.EGO_LITE_STATE_PATH;
    } else {
      process.env.EGO_LITE_STATE_PATH = previousStatePath;
    }
    if (previousProfileId === undefined) {
      delete process.env.EGO_LITE_PROFILE_ID;
    } else {
      process.env.EGO_LITE_PROFILE_ID = previousProfileId;
    }
    if (previousServerName === undefined) {
      delete process.env.EGO_LITE_SERVER_NAME;
    } else {
      process.env.EGO_LITE_SERVER_NAME = previousServerName;
    }
  }
}

async function runPackagedCli() {
  const hostArguments = [];
  for (let index = 1; index < process.argv.length; index += 1) {
    const argument = String(process.argv[index] || "");
    if (
      !argument ||
      argument === "--" ||
      argument === "--cli" ||
      isElectronApplicationArgument(argument)
    ) {
      continue;
    }
    if (argument === "--profile") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) continue;
    hostArguments.push(argument);
  }
  const exitCode = await runHostCommand(hostArguments);
  app.exit(Number.isInteger(exitCode) ? exitCode : 0);
}

async function runPendingProfileImport() {
  const pending = await takePendingProfileImport();
  if (!pending) return { stopped: false };

  app.releaseSingleInstanceLock();
  let exitCode = 1;
  let failure;
  const previousSelfMigrationFlag =
    process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION;
  process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION = "1";
  try {
    exitCode = await runHostCommand([
      "--migrate-profile",
      "--from",
      pending.sourcePath,
    ]);
  } catch (error) {
    failure = error;
    console.error(
      `[ego-lite] requested profile import failed: ${error?.stack || error?.message || String(error)}`,
    );
  } finally {
    if (previousSelfMigrationFlag === undefined) {
      delete process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION;
    } else {
      process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION =
        previousSelfMigrationFlag;
    }
  }

  const reacquired = app.requestSingleInstanceLock();
  if (!reacquired) {
    app.quit();
    return { stopped: true };
  }
  if (failure || exitCode !== 0) {
    await dialog.showMessageBox({
      type: "warning",
      title: "Browser data import did not finish",
      message: "ego lite will start with the existing Linux profile.",
      detail:
        "Close the source browser and use Import data again to retry. Passwords from Chromium's basic plaintext store can be imported; keyring-backed passwords remain separate.",
      buttons: ["Continue"],
    });
  }
  return { stopped: false };
}

async function requestProfileImport() {
  if (importRequestPending) return { restarting: true };
  const forcedSource = process.env.EGO_LITE_IMPORT_SOURCE?.trim();
  let sourcePath = forcedSource ? resolve(forcedSource) : null;
  if (!sourcePath) {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Import browser data",
      buttonLabel: "Import",
      properties: ["openDirectory"],
      message:
        "Choose a Chromium, Chrome, or Brave profile or its browser data directory.",
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { cancelled: true };
    }
    sourcePath = resolve(selection.filePaths[0]);
  }

  importRequestPending = true;
  await savePrimarySession();
  await writePendingProfileImport(sourcePath);
  mainWindow?.webContents.send("ego-lite:import-status", {
    state: "restarting",
  });
  app.relaunch();
  app.exit(0);
  return { restarting: true };
}

async function maybeOfferPackagedMigration() {
  const promptEnabled =
    app.isPackaged || process.env.EGO_LITE_MIGRATION_PROMPT === "1";
  if (
    !promptEnabled ||
    CLI_MODE ||
    process.env.EGO_LITE_SKIP_MIGRATION === "1" ||
    !PROFILE_MANAGER_ENABLED ||
    ACTIVE_PROFILE_ID !== "default"
  ) {
    return { stopped: false };
  }

  try {
    await readFile(MIGRATION_PROMPT_MARKER, "utf8");
    return { stopped: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (await profileLooksUsable(join(PROFILE_DIR, "Default"))) {
    return { stopped: false };
  }
  const candidates = await findMigrationProfiles();
  if (candidates.length === 0) return { stopped: false };

  let source = candidates[0];
  const forcedSource = process.env.EGO_LITE_MIGRATION_SOURCE?.trim();
  if (forcedSource) {
    source = {
      name: "Selected browser",
      profileDir: resolve(forcedSource),
    };
  } else if (candidates.length > 1) {
    const candidateList = candidates
      .map(
        (candidate) =>
          `${candidate.name} / ${candidate.profileName}: ${candidate.profileDir}`,
      )
      .join("\n");
    const selection = await dialog.showOpenDialog({
      title: "Choose a browser profile to migrate",
      buttonLabel: "Choose profile",
      defaultPath: candidates[0].profileDir,
      properties: ["openDirectory"],
      message:
        "More than one Chromium-family profile is available. Choose one profile directory to import.",
      detail: candidateList,
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { stopped: false };
    }
    source = {
      name: "Selected browser",
      profileDir: resolve(selection.filePaths[0]),
    };
  }

  await writeFile(
    MIGRATION_PROMPT_MARKER,
    `${new Date().toISOString()}\nsource=${source.profileDir}\n`,
  );

  const forcedChoice = app.isPackaged
    ? undefined
    : process.env.EGO_LITE_MIGRATION_CHOICE;
  let response;
  if (forcedChoice === "migrate") response = 0;
  else if (forcedChoice === "skip") response = 1;
  else {
    ({ response } = await dialog.showMessageBox({
      type: "question",
      title: "Bring your browser setup to ego lite?",
      message: `A ${source.name} profile is available for migration.`,
      detail:
        "Migrate bookmarks, settings, extensions, storage, readable cookies, and basic-store passwords into ego lite. Keyring-backed passwords remain separate. Close the source browser before continuing.",
      buttons: ["Migrate now", "Keep separate"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }));
  }
  if (response !== 0) return { stopped: false };

  app.releaseSingleInstanceLock();
  let exitCode = 1;
  const previousSelfMigrationFlag =
    process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION;
  process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION = "1";
  try {
    exitCode = await runHostCommand([
      "--migrate-profile",
      "--from",
      source.profileDir,
    ]);
  } catch (error) {
    console.error(
      `[ego-lite] packaged profile migration failed: ${error?.stack || error?.message || String(error)}`,
    );
  } finally {
    if (previousSelfMigrationFlag === undefined) {
      delete process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION;
    } else {
      process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION =
        previousSelfMigrationFlag;
    }
  }
  const reacquired = app.requestSingleInstanceLock();
  if (!reacquired) {
    app.quit();
    return { stopped: true };
  }
  if (exitCode !== 0) {
    await dialog.showMessageBox({
      type: "warning",
      title: "Profile migration did not finish",
      message: "ego lite will start with its separate Linux profile.",
      detail:
        "You can retry later with ego-lite --migrate-profile --from /path/to/browser-profile after closing the source browser.",
      buttons: ["Continue"],
    });
  }
  return { stopped: false };
}

ipcMain.handle("ego-lite:navigate", (_event, value) => navigate(value));
ipcMain.handle("ego-lite:back", () => {
  if (browserView?.webContents.navigationHistory.canGoBack()) {
    browserView.webContents.navigationHistory.goBack();
  }
});
ipcMain.handle("ego-lite:forward", () => {
  if (browserView?.webContents.navigationHistory.canGoForward()) {
    browserView.webContents.navigationHistory.goForward();
  }
});
ipcMain.handle("ego-lite:reload", () => browserView?.webContents.reload());
ipcMain.handle("ego-lite:toggle-tab-mute", () => setActiveTabMuted());
ipcMain.handle("ego-lite:find-in-page", (_event, value) => {
  const text = String(value?.text || "");
  if (!browserView || !text) {
    browserView?.webContents.stopFindInPage("clearSelection");
    return { cleared: true };
  }
  const requestId = browserView.webContents.findInPage(text, {
    forward: value?.forward !== false,
    findNext: Boolean(value?.findNext),
    matchCase: Boolean(value?.matchCase),
  });
  return { requestId };
});
ipcMain.handle("ego-lite:close-find", () => {
  browserView?.webContents.stopFindInPage("clearSelection");
  mainWindow?.webContents.send("ego-lite:find-result", {
    activeMatchOrdinal: 0,
    matches: 0,
    finalUpdate: true,
    cleared: true,
  });
  return { closed: true };
});
ipcMain.handle("ego-lite:import-data", () => requestProfileImport());
ipcMain.handle("ego-lite:toggle-bookmark", () => toggleCurrentBookmark());
ipcMain.handle("ego-lite:get-browser-sync", () => currentBrowserSync());
ipcMain.handle("ego-lite:set-browser-sync", (_event, value) =>
  setBrowserSync(value || {}),
);
ipcMain.handle("ego-lite:choose-browser-sync-source", () =>
  chooseBrowserSyncSource(),
);
ipcMain.handle("ego-lite:sync-browser-data", () =>
  runBrowserDataSync({ force: true }),
);
ipcMain.handle("ego-lite:switch-profile", (_event, value) => {
  const id = String(value?.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
    throw new Error("profile id is invalid");
  }
  return relaunchForProfile(id);
});
ipcMain.handle("ego-lite:create-profile", (_event, value) =>
  createProfile(value || {}),
);
ipcMain.handle("ego-lite:show-download", (_event, id) => {
  const download = downloadStates.get(String(id));
  if (!download?.path) throw new Error("download is not ready");
  shell.showItemInFolder(download.path);
  return { shown: true };
});
ipcMain.handle("ego-lite:open-download", async (_event, id) => {
  const download = downloadStates.get(String(id));
  return openDownloadPath(download?.path, (path) => shell.openPath(path));
});
ipcMain.handle("ego-lite:clear-history", () => {
  historyEntries = [];
  writeHistory();
  publishBrowserState();
  return currentBrowserState();
});
ipcMain.handle("ego-lite:add-reading-list", () => addCurrentToReadingList());
ipcMain.handle("ego-lite:remove-reading-list", (_event, url) =>
  removeFromReadingList(url),
);
ipcMain.handle("ego-lite:set-extension", (_event, value) =>
  setExtensionEnabled(value || {}),
);
ipcMain.handle("ego-lite:set-tab-group", (_event, value) => {
  const request = value || {};
  if (request.ungroup || request.groupId || request.targetId || request.title) {
    return setTabGroup(request);
  }
  return updateTabGroup(request);
});
ipcMain.handle("ego-lite:new-tab", () => createUserTab());
ipcMain.handle("ego-lite:new-private-tab", () =>
  createUserTab({ privateMode: true }),
);
ipcMain.handle("ego-lite:close-tab", async (_event, targetId) => {
  if (targetId) await closeManagedView(String(targetId));
  else await closeActiveTab();
  return managedTabState();
});
ipcMain.handle("ego-lite:reopen-closed-tab", () => reopenClosedTab());
ipcMain.handle("ego-lite:set-space-ownership", (_event, value) =>
  setTaskSpaceOwnership(value || {}),
);
ipcMain.handle("ego-lite:stop-space", (_event, value) =>
  stopTaskSpace(value || {}),
);
ipcMain.handle("ego-lite:list-tabs", () => managedTabState());
ipcMain.handle("ego-lite:activate-tab", (_event, targetId) => {
  const managed = managedViews.get(targetId);
  if (!managed) throw new Error(`Electron target not found: ${targetId}`);
  setActiveBrowserView(managed.view);
  return managedTabState();
});
ipcMain.handle("ego-lite:browser-state", () => currentBrowserState());

const hasSingleInstance =
  CLI_PROFILE_MIGRATION || app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    void routeExternalTargets([filePath]);
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    void routeExternalTargets([url]);
  });

  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    void routeExternalTargets(commandLine, {
      cwd: workingDirectory,
      commandLine: true,
    });
  });

  app.whenReady().then(async () => {
    if (!CLI_MODE) {
      const pendingImport = await runPendingProfileImport().catch((error) => {
        console.error(
          `[ego-lite] pending profile import failed: ${error?.stack || error?.message || String(error)}`,
        );
        return { stopped: false };
      });
      if (pendingImport.stopped) return;
      const migration = await maybeOfferPackagedMigration().catch((error) => {
        console.error(
          `[ego-lite] migration onboarding failed: ${error?.stack || error?.message || String(error)}`,
        );
        return { stopped: false };
      });
      if (migration.stopped) return;
    }
    if (CLI_MODE) {
      if (!CLI_PROFILE_MIGRATION) {
        await createWindow();
        await startBridge();
      }
      try {
        await runPackagedCli();
      } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        app.exit(1);
      }
      return;
    }
    await createWindow();
    await startBridge();
    const initialExternalTargets = pendingExternalTargets;
    pendingExternalTargets = [];
    await routeExternalTargets(initialExternalTargets);
    if (!CLI_MODE) {
      void runBrowserDataSync();
      browserDataSyncTimer = setInterval(
        () => void runBrowserDataSync(),
        60 * 1000,
      );
    }
    void startAutoUpdater();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    if (spaceSaveTimer) clearTimeout(spaceSaveTimer);
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = undefined;
    if (browserStateSyncTimer) clearInterval(browserStateSyncTimer);
    if (browserDataSyncTimer) clearInterval(browserDataSyncTimer);
    saveWindowStateSync();
    savePrimarySessionSync();
    saveSpaceSessionSync();
    bridgeServer?.close();
    void unlink(bridgeFile).catch(() => {});
  });
}
