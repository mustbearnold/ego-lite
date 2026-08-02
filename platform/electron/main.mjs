import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
} from "electron";
import { mkdirSync } from "node:fs";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  findSingleMigrationProfile,
  profileLooksUsable,
} from "./migration-discovery.mjs";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(
  process.env.EGO_LITE_PROFILE_DIR ||
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "ego-lite",
      "chromium-profile",
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
let agentTaskState = null;
const bridgeFile = join(PROFILE_DIR, "ego-lite-bridge.json");
const MIGRATION_PROMPT_MARKER = join(PROFILE_DIR, ".migration-prompted");

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
    active: managed.view === browserView,
  }));
}

function currentBrowserState() {
  return {
    title: browserView?.webContents.getTitle() || "ego lite",
    url: browserView?.webContents.getURL() || "about:blank",
    agentTaskState,
    canGoBack: browserView?.webContents.navigationHistory.canGoBack() || false,
    canGoForward:
      browserView?.webContents.navigationHistory.canGoForward() || false,
    tabs: managedTabState(),
  };
}

function publishBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
  mainWindow.webContents.send("ego-lite:browser-state", currentBrowserState());
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
  { spaceId = null, spaceName = null, tabId = null } = {},
) {
  installViewListeners(view);
  installPermissionHandlers(view.webContents.session);
  const targetId = await targetIdForView(view);
  managedViews.set(targetId, { view, spaceId, spaceName, tabId });
  publishBrowserState();
  return targetId;
}

async function createManagedView({
  spaceId,
  spaceName = null,
  url = "about:blank",
}) {
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
  managedViews.delete(targetId);
  if (managed.view === browserView) {
    const fallback = [...managedViews.values()][0]?.view;
    if (fallback) setActiveBrowserView(fallback);
  }
  managed.view.webContents.close();
  publishBrowserState();
  return { closed: true };
}

function managedViewForTarget(targetId) {
  if (targetId) return managedViews.get(targetId)?.view || null;
  return browserView || null;
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
}

async function navigate(value) {
  return navigateOnView(browserView, value);
}

async function createWindow() {
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

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  enableAccessibility(browserView);
  mainWindow.setBrowserView(browserView);
  resizeBrowserView();
  mainWindow.on("resize", resizeBrowserView);
  mainWindow.on("closed", () => {
    browserView = null;
    mainWindow = null;
  });

  browserView.webContents.setWindowOpenHandler(({ url }) => {
    void navigate(url).catch((error) => {
      console.error(`[ego-lite] cannot open ${url}: ${error.message}`);
    });
    return { action: "deny" };
  });
  await loadMigratedExtensions(browserView.webContents.session);
  await browserView.webContents.loadURL("about:blank");
  void registerManagedView(browserView, { tabId: "default" }).catch((error) => {
    console.error(
      `[ego-lite] cannot register default browser tab: ${error.message}`,
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
  const source = await findSingleMigrationProfile();
  if (!source) return { stopped: false };

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
        "Migrate bookmarks, settings, extensions, storage, and readable cookies into ego lite. Saved passwords are not copied. Close the source browser before continuing.",
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
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    bridgeServer?.close();
    void unlink(bridgeFile).catch(() => {});
  });
}
