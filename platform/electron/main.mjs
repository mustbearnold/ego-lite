import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  findMigrationProfiles,
  profileLooksUsable,
} from "./migration-discovery.mjs";
import { createUpdateController } from "./update.mjs";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(
  process.env.EGO_LITE_PROFILE_DIR ||
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "ego-lite",
      "chromium-profile",
    ),
);
const STATE_PATH = resolve(
  process.env.EGO_LITE_STATE_PATH ||
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "ego-lite",
      "task-spaces.json",
    ),
);
const TOOLBAR_HEIGHT = 52;
const CLI_MODE = process.argv.includes("--cli");
const CLI_PROFILE_MIGRATION =
  CLI_MODE && process.argv.includes("--migrate-profile");

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
const sessionPermissionStates = new WeakMap();
const sessionExtensionLoads = new WeakMap();
let bridgeServer;
let bridgeToken;
let browserStateSyncTimer;
let updateController;
let updateState = {
  status: "disabled",
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
  message: null,
};
let agentTaskState = null;
const bridgeFile = join(PROFILE_DIR, "ego-lite-bridge.json");
const MIGRATION_PROMPT_MARKER = join(PROFILE_DIR, ".migration-prompted");
const MIGRATED_TABS_FILE = "ego-lite-migrated-tabs.json";
const PRIMARY_SESSION_FILE = "ego-lite-session.json";
const PRIMARY_SESSION_PATH = join(PROFILE_DIR, PRIMARY_SESSION_FILE);
const PENDING_IMPORT_FILE = "ego-lite-pending-import.json";
const PENDING_IMPORT_PATH = join(PROFILE_DIR, PENDING_IMPORT_FILE);
const SPACE_SESSION_FILE = "ego-lite-space-session.json";
const SPACE_SESSION_PATH = join(PROFILE_DIR, SPACE_SESSION_FILE);
let sessionSaveTimer;
let spaceSaveTimer;
let importRequestPending = false;

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

function managedTabState() {
  return [...managedViews.entries()].map(([targetId, managed]) => ({
    targetId,
    spaceId: managed.spaceId,
    spaceName: managed.spaceName || null,
    url: managed.view.webContents.getURL() || "about:blank",
    title: managed.view.webContents.getTitle() || "",
    tabGroup: managed.tabGroup || null,
    active: managed.view === browserView,
  }));
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
  return {
    title: browserView?.webContents.getTitle() || "ego lite",
    url: browserView?.webContents.getURL() || "about:blank",
    agentTaskState,
    controlState: currentControlState(),
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

function primarySessionManifest() {
  const tabs = primaryManagedViews()
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
  for (const [, managed] of primaryManagedViews()) {
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
    y: TOOLBAR_HEIGHT,
    width: Math.max(1, width),
    height: Math.max(1, height - TOOLBAR_HEIGHT),
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

function installViewListeners(view) {
  for (const eventName of [
    "did-finish-load",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
  ]) {
    view.webContents.on(eventName, publishBrowserState);
  }
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if (input.alt || input.shift || !(input.control || input.meta)) return;
    const key = String(input.key || "").toLowerCase();
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

async function loadMigratedExtensions(webSession) {
  const existing = sessionExtensionLoads.get(webSession);
  if (existing) return existing;

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
        let loadedVersion = false;
        try {
          const details = await webSession.loadExtension(extensionPath, {
            allowFileAccess: true,
          });
          loaded.push({
            id: details.id || extensionEntry.name,
            name: details.name || manifest.name || extensionEntry.name,
            version: details.version || manifest.version || version,
          });
          loadedVersion = true;
        } catch (error) {
          console.warn(
            `[ego-lite] could not load migrated extension ${extensionEntry.name}/${version}: ${error?.message || String(error)}`,
          );
        }
        if (loadedVersion) break;
      }
    }
    if (loaded.length > 0) {
      console.log(`[ego-lite] loaded ${loaded.length} migrated extension(s)`);
    }
    return loaded;
  })();
  sessionExtensionLoads.set(webSession, loadPromise);
  return loadPromise;
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
  { spaceId = null, spaceName = null, tabId = null, tabGroup = null } = {},
) {
  installViewListeners(view);
  installPermissionHandlers(view.webContents.session);
  const targetId = await targetIdForView(view);
  managedViews.set(targetId, {
    view,
    spaceId,
    spaceName,
    tabId,
    tabGroup,
  });
  publishBrowserState();
  return targetId;
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
  enableAccessibility(view);
  await loadMigratedExtensions(view.webContents.session);
  await inheritPrimaryCookies(view.webContents.session);
  view.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
    void navigateOnView(view, openedUrl).catch((error) => {
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

async function closeManagedView(targetId) {
  const managed = managedViews.get(targetId);
  if (!managed) return { closed: false };
  const wasPrimary = managed.spaceId === null;
  const wasActive = managed.view === browserView;
  managedViews.delete(targetId);
  if (wasActive) {
    const fallback =
      primaryManagedViews()[0]?.[1].view || [...managedViews.values()][0]?.view;
    browserView = fallback || null;
    if (fallback) setActiveBrowserView(fallback);
  }
  managed.view.webContents.close();
  if (wasPrimary && primaryManagedViews().length === 0 && mainWindow) {
    const replacement = await createPrimaryBrowserView({
      url: "about:blank",
      tabId: "default",
    });
    setActiveBrowserView(replacement.view);
  }
  publishBrowserState();
  return { closed: true };
}

async function createUserTab() {
  const primary = await createPrimaryBrowserView({
    url: "about:blank",
    tabId: `user-${randomUUID()}`,
  });
  setActiveBrowserView(primary.view);
  return managedTabState();
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
    agentTaskState = value ? value.slice(0, 120) : null;
    publishBrowserState();
    return { agentTaskState };
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
    `${JSON.stringify({ port: address.port, token: bridgeToken })}\n`,
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
  return navigateOnView(browserView, value);
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
} = {}) {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  enableAccessibility(view);
  view.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
    void navigateOnView(view, openedUrl).catch((error) => {
      console.error(`[ego-lite] cannot open ${openedUrl}: ${error.message}`);
    });
    return { action: "deny" };
  });
  await loadMigratedExtensions(view.webContents.session);
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
  });
  return { view, targetId };
}

async function createWindow() {
  const migrated = await readMigratedTabsManifest();
  const persisted = migrated ? null : await readPrimarySessionManifest();
  const persistedSpaces = await readSpaceSessionManifest();
  const stored = migrated || persisted;
  const restoredTabs = stored?.tabs || [];
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
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

  const firstTab = restoredTabs[0] || {
    url: "about:blank",
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
  mainWindow.on("resize", resizeBrowserView);
  mainWindow.on("closed", () => {
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
  const { runHost } = await import(pathToFileURL(hostPath).href);
  return runHost(args);
}

async function runPackagedCli() {
  const exitCode = await runHostCommand(
    process.argv.slice(2).filter((arg) => arg !== "--cli"),
  );
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
    process.env.EGO_LITE_SKIP_MIGRATION === "1"
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
ipcMain.handle("ego-lite:import-data", () => requestProfileImport());
ipcMain.handle("ego-lite:set-tab-group", (_event, value) =>
  updateTabGroup(value || {}),
);
ipcMain.handle("ego-lite:new-tab", () => createUserTab());
ipcMain.handle("ego-lite:close-tab", () => closeActiveTab());
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
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
    void startAutoUpdater();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    if (spaceSaveTimer) clearTimeout(spaceSaveTimer);
    if (browserStateSyncTimer) clearInterval(browserStateSyncTimer);
    savePrimarySessionSync();
    saveSpaceSessionSync();
    bridgeServer?.close();
    void unlink(bridgeFile).catch(() => {});
  });
}
