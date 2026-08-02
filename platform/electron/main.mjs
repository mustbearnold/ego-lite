import { app, BrowserView, BrowserWindow, ipcMain } from "electron";
import { mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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

mkdirSync(PROFILE_DIR, { recursive: true });
app.setPath("userData", PROFILE_DIR);
app.setName("ego lite");
app.setAppUserModelId("com.citrolabs.ego-lite");
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-allow-origins", "*");
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
let bridgeServer;
let bridgeToken;
const bridgeFile = join(PROFILE_DIR, "ego-lite-bridge.json");

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

function publishBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed() || !browserView) return;
  mainWindow.webContents.send("ego-lite:browser-state", {
    title: browserView.webContents.getTitle() || "ego lite",
    url: browserView.webContents.getURL() || "about:blank",
    canGoBack: browserView.webContents.navigationHistory.canGoBack(),
    canGoForward: browserView.webContents.navigationHistory.canGoForward(),
  });
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
    view.webContents.on(eventName, () => {
      if (view === browserView) publishBrowserState();
    });
  }
}

function enableAccessibility(view) {
  if (typeof view.webContents.setAccessibilitySupportEnabled === "function") {
    view.webContents.setAccessibilitySupportEnabled(true);
  }
}

async function registerManagedView(
  view,
  { spaceId = null, tabId = null } = {},
) {
  installViewListeners(view);
  const targetId = await targetIdForView(view);
  managedViews.set(targetId, { view, spaceId, tabId });
  return targetId;
}

async function createManagedView({ spaceId, url = "about:blank" }) {
  const partition = `persist:ego-lite-${String(spaceId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });
  enableAccessibility(view);
  view.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
    void navigateOnView(view, openedUrl).catch((error) => {
      console.error(`[ego-lite] cannot open ${openedUrl}: ${error.message}`);
    });
    return { action: "deny" };
  });
  await view.webContents.loadURL(normalizeUrl(url));
  const targetId = await registerManagedView(view, { spaceId });
  setActiveBrowserView(view);
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
  return { closed: true };
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
  if (pathname === "/create-tab") return createManagedView(body);
  if (pathname === "/activate-tab") {
    const managed = managedViews.get(body.targetId);
    if (!managed)
      throw new Error(`Electron target not found: ${body.targetId}`);
    setActiveBrowserView(managed.view);
    return { activated: true };
  }
  if (pathname === "/close-tab") return closeManagedView(body.targetId);
  if (pathname === "/tabs") {
    return {
      tabs: [...managedViews.entries()].map(([targetId, managed]) => ({
        targetId,
        spaceId: managed.spaceId,
        url: managed.view.webContents.getURL(),
        title: managed.view.webContents.getTitle(),
        active: managed.view === browserView,
      })),
    };
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

function createWindow() {
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
  void browserView.webContents.loadURL("about:blank");
  void registerManagedView(browserView, { tabId: "default" }).catch((error) => {
    console.error(
      `[ego-lite] cannot register default browser tab: ${error.message}`,
    );
  });
  void mainWindow.loadFile(join(MAIN_DIR, "renderer", "index.html"));
}

async function runPackagedCli() {
  const hostPath = app.isPackaged
    ? join(process.resourcesPath, "ego-lite", "linux", "ego-browser.mjs")
    : resolve(MAIN_DIR, "..", "linux", "ego-browser.mjs");
  const { runHost } = await import(pathToFileURL(hostPath).href);
  const args = process.argv.slice(2).filter((arg) => arg !== "--cli");
  const exitCode = await runHost(args);
  app.exit(Number.isInteger(exitCode) ? exitCode : 0);
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
ipcMain.handle("ego-lite:browser-state", () => ({
  title: browserView?.webContents.getTitle() || "ego lite",
  url: browserView?.webContents.getURL() || "about:blank",
  canGoBack: browserView?.webContents.navigationHistory.canGoBack() || false,
  canGoForward:
    browserView?.webContents.navigationHistory.canGoForward() || false,
}));

const hasSingleInstance = app.requestSingleInstanceLock();
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
    createWindow();
    await startBridge();
    if (CLI_MODE) {
      try {
        await runPackagedCli();
      } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        app.exit(1);
      }
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    bridgeServer?.close();
    void unlink(bridgeFile).catch(() => {});
  });
}
