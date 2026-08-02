#!/usr/bin/env node

import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  rename,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HOST_DIR, "../..");
const INSTALL_DIR = resolve(HOST_DIR, "..");
const DEFAULT_PROFILE_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "ego-lite",
  "chromium-profile",
);
const DEFAULT_STATE_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "ego-lite",
  "task-spaces.json",
);
const HOST_VERSION = "linux-host/0.4.0";
const nativeFetch = globalThis.fetch?.bind(globalThis);
const DEFAULT_EXECUTABLES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];
const MIGRATABLE_PROFILE_FILES = [
  "Bookmarks",
  "Bookmarks.bak",
  "Preferences",
  "Secure Preferences",
  "Favicons",
  "Favicons-journal",
  "History",
  "History-journal",
  "Top Sites",
  "Top Sites-journal",
  "Web Data",
  "Web Data-journal",
];
const MIGRATABLE_PROFILE_DIRECTORIES = [
  "Extensions",
  "Extension State",
  "IndexedDB",
  "Local Storage",
  "Session Storage",
  "Web Applications",
];
const MIGRATION_SOURCES = [
  {
    name: "Chromium",
    userDataDir: join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "chromium",
    ),
    executableCandidates: DEFAULT_EXECUTABLES,
  },
  {
    name: "Google Chrome",
    userDataDir: join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "google-chrome",
    ),
    executableCandidates: [
      "google-chrome",
      "google-chrome-stable",
      ...DEFAULT_EXECUTABLES,
    ],
  },
  {
    name: "Google Chrome Beta",
    userDataDir: join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "google-chrome-beta",
    ),
    executableCandidates: ["google-chrome-beta", ...DEFAULT_EXECUTABLES],
  },
  {
    name: "Brave",
    userDataDir: join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "BraveSoftware",
      "Brave-Browser",
    ),
    executableCandidates: ["brave-browser", ...DEFAULT_EXECUTABLES],
  },
];
const CONTEXT_SCOPED_BROWSER_METHODS = new Set([
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
]);

const HELP = `ego-browser (Linux host)

Runs the open-source ego-browser SDK against a local Chromium instance.

Usage:
  ego-browser <<'JS'
  await taskSpaces.useOrCreate('demo')
  await browser.openOrReuseTab('https://example.com', { wait: true })
  console.log(await page.snapshot())
  JS

Commands:
  ego-browser --doctor
  ego-browser --launch
  ego-browser --reload
  ego-browser --migrate-profile [--from PATH]
  ego-browser nodejs [--sdk-path PATH]

Environment:
  EGO_BROWSER_EXECUTABLE       Chromium/Chrome executable to launch
  EGO_LITE_PROFILE_DIR         Persistent browser profile directory
  EGO_LITE_HEADLESS=1          Run Chromium headlessly (useful in CI)
  EGO_BROWSER_AGENT_WORKSPACE  Skill workspace used by the SDK

Migration:
  --migrate-profile imports bookmarks, browser settings, extensions, local
  storage, and readable cookies into the Linux profile. Close the source
  browser first. Existing Linux profile data is backed up before replacement;
  saved passwords are not copied across browser keyrings.
`;

function fail(message) {
  throw new Error(message);
}

function cdpError(error) {
  const message = error?.message || error?.error || String(error);
  const result = new Error(message);
  if (error?.code) result.code = error.code;
  return result;
}

class BrowserConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 10_000_000;
    this.pending = new Map();
    this.onEvent = () => {};
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(
          error instanceof Error ? error : new Error(String(error)),
        );
      };
      socket.addEventListener("open", resolveOnce, { once: true });
      socket.addEventListener(
        "error",
        (event) => {
          rejectOnce(
            event?.error || new Error("failed to connect to Chromium CDP"),
          );
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) =>
      this.handleMessage(event.data),
    );
    socket.addEventListener("close", () => {
      const error = new Error("Chromium CDP connection closed");
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
    return this;
  }

  async request(method, params = {}, sessionId = undefined) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      fail("Chromium CDP connection is not open");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      try {
        this.socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      fail("Chromium CDP connection is not open");
    }
    this.socket.send(payload);
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(cdpError(message.error));
      else entry.resolve(message.result || {});
      return;
    }
    this.onEvent(JSON.stringify(message));
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // The browser is intentionally left running for the next heredoc.
    }
  }
}

class ElectronBridge {
  constructor({ port, token }) {
    this.url = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  async request(path, body = {}) {
    if (!nativeFetch) fail("Node fetch is unavailable for the Electron bridge");
    const response = await nativeFetch(`${this.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ego-lite-token": this.token,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        payload.error || `Electron bridge request failed: ${path}`,
      );
      error.code = response.status;
      throw error;
    }
    return payload;
  }
}

class LinuxEgoHost {
  constructor(
    connection,
    { profileDir, statePath, browserVersion, browserUserAgent, electronBridge },
  ) {
    this.connection = connection;
    this.profileDir = profileDir;
    this.statePath = statePath;
    this.browserVersion = browserVersion;
    this.browserUserAgent = browserUserAgent;
    this.electronBridge = electronBridge;
    this.isElectron = /Electron\//.test(browserUserAgent || "");
    this.taskSpaceMode = this.isElectron ? "tabs" : "contexts";
    this.onCDPMessage = null;
    this.onSendCDPMessageError = null;
    this.selectedSpaceId = null;
    this.selectedTargetId = null;
    this.state = { version: 1, nextId: 1, spaces: [] };
    this.contextIds = new Set();
    this.defaultContextId = null;
    this.connection.onEvent = (message) => this.onCDPMessage?.(message);
  }

  async init() {
    await this.loadState();
    const contexts = await this.connection.request("Target.getBrowserContexts");
    this.contextIds = new Set(contexts.browserContextIds || []);
    this.defaultContextId = contexts.defaultBrowserContextId || null;
    if (this.taskSpaceMode === "tabs") {
      for (const space of this.state.spaces) {
        space.mode = "tab";
      }
    }
    await this.ensureDefaultTab();
    return this;
  }

  async loadState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.spaces)) {
        this.state = {
          version: 1,
          nextId: Number(parsed.nextId) || 1,
          spaces: parsed.spaces.filter((space) => Number.isFinite(space?.id)),
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(temporaryPath, this.statePath);
  }

  async ensureDefaultTab() {
    const targets = await this.allTargets();
    if (
      targets.some(
        (target) =>
          target.type === "page" &&
          target.browserContextId === this.defaultContextId,
      )
    ) {
      return;
    }
    const created = await this.createBrowserTab("about:blank");
    this.selectedTargetId = created.targetId;
  }

  async allTargets() {
    const result = await this.connection.request("Target.getTargets");
    return result.targetInfos || [];
  }

  currentSpace() {
    if (this.selectedSpaceId === null) return null;
    return (
      this.state.spaces.find((space) => space.id === this.selectedSpaceId) ||
      null
    );
  }

  async selectedContextId() {
    const space = this.currentSpace();
    if (!space) return undefined;
    await this.ensureSpaceContext(space);
    return space.contextId || undefined;
  }

  async ensureSpaceContext(space) {
    if (this.isTabScopedSpace(space)) {
      space.mode = "tab";
      space.contextId = this.defaultContextId;
      await this.ensureSpaceTab(space);
      return;
    }
    if (space.contextId && this.contextIds.has(space.contextId)) return;
    let result;
    try {
      result = await this.connection.request("Target.createBrowserContext", {
        disposeOnDetach: false,
      });
    } catch (error) {
      if (!this.defaultContextId || !isBrowserContextUnavailable(error)) {
        throw error;
      }
      this.taskSpaceMode = "tabs";
      space.mode = "tab";
      space.contextId = this.defaultContextId;
      await this.ensureSpaceTab(space);
      return;
    }
    space.mode = "context";
    space.contextId = result.browserContextId;
    this.contextIds.add(space.contextId);
    await this.saveState();
    const created = await this.connection.request("Target.createTarget", {
      url: "about:blank",
      browserContextId: space.contextId,
    });
    this.selectedTargetId = created.targetId;
    await this.activateTarget(created.targetId);
    await this.copyDefaultCookies(created.targetId).catch(() => {});
  }

  async ensureSpaceTab(space) {
    const targetIds = this.spaceTargetIds(space);
    const targets = await this.allTargets();
    let activeTargetId = null;
    if (this.electronBridge && targetIds.length > 0) {
      const bridgeTabs = await this.electronBridge.request("/tabs");
      activeTargetId = bridgeTabs.tabs?.find(
        (tab) => targetIds.includes(tab.targetId) && tab.active,
      )?.targetId;
    }
    const existing =
      targets.find(
        (target) =>
          target.type === "page" && target.targetId === activeTargetId,
      ) ||
      [...targetIds]
        .reverse()
        .map((targetId) =>
          targets.find(
            (target) => target.type === "page" && target.targetId === targetId,
          ),
        )
        .find(Boolean);
    if (existing) {
      this.selectedTargetId = existing.targetId;
      await this.activateTarget(existing.targetId);
      return;
    }
    const created = await this.createBrowserTab("about:blank", space);
    this.rememberSpaceTarget(space, created.targetId);
    this.selectedTargetId = created.targetId;
    await this.saveState();
    await this.activateTarget(created.targetId);
  }

  async copyDefaultCookies(targetId) {
    const targets = await this.allTargets();
    const defaultTarget = targets.find(
      (target) =>
        target.type === "page" &&
        target.browserContextId === this.defaultContextId,
    );
    if (!defaultTarget) return;
    const sourceSessionId = await this.attachTarget(defaultTarget.targetId);
    const cookies = await this.connection.request(
      "Network.getAllCookies",
      {},
      sourceSessionId,
    );
    if (!Array.isArray(cookies.cookies) || cookies.cookies.length === 0) return;
    const sessionId = await this.attachTarget(targetId);
    await this.connection.request(
      "Network.setCookies",
      { cookies: cookies.cookies },
      sessionId,
    );
  }

  async listTaskSpaces() {
    const targets = await this.allTargets();
    return {
      taskSpaces: this.state.spaces.map((space) => ({
        ...space,
        recentTabTitles: targets
          .filter(
            (target) =>
              target.type === "page" &&
              !isElectronShellTarget(target) &&
              (this.isTabScopedSpace(space)
                ? this.spaceTargetIds(space).includes(target.targetId)
                : target.browserContextId === space.contextId),
          )
          .map((target) => target.title || "")
          .filter(Boolean),
      })),
    };
  }

  async createTaskSpace(name) {
    if (typeof name !== "string" || name.trim() === "") {
      return this.error("EGO_INVALID_ARGUMENT", "task space name is required");
    }
    const space = {
      taskId: `linux-space-${this.state.nextId}`,
      id: this.state.nextId++,
      name,
      createdBy: "agent",
      ownership: "agent",
      createdAt: new Date().toISOString(),
      contextId: null,
      mode: this.taskSpaceMode === "tabs" ? "tab" : "context",
      tabTargetIds: [],
    };
    this.state.spaces.push(space);
    await this.saveState();
    this.selectedSpaceId = space.id;
    await this.ensureSpaceContext(space);
    return { ...space };
  }

  async useTaskSpace(id) {
    const space = this.findSpace(id);
    if (!space)
      return this.error(
        "EGO_TASK_SPACE_NOT_FOUND",
        `task space not found: ${id}`,
      );
    this.selectedSpaceId = space.id;
    await this.ensureSpaceContext(space);
    const tabs = (await this.listTabs()).tabs;
    if (
      !this.selectedTargetId ||
      !tabs.some((tab) => tab.targetId === this.selectedTargetId)
    ) {
      this.selectedTargetId = tabs[0]?.targetId || null;
    }
    return { ...space };
  }

  async claimTaskSpace(id, name) {
    const space = this.findSpace(id);
    if (!space)
      return this.error(
        "EGO_TASK_SPACE_NOT_FOUND",
        `task space not found: ${id}`,
      );
    if (name && !space.name) space.name = name;
    space.ownership = "agent";
    this.selectedSpaceId = space.id;
    await this.ensureSpaceContext(space);
    await this.saveState();
    return { ...space };
  }

  async completeTaskSpace() {
    const space = this.requireSelectedSpace();
    if (space.ownership === "user") {
      return this.error(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "task space is under user control",
      );
    }
    space.ownership = "user";
    await this.saveState();
    return { ...space };
  }

  async handOffTaskSpace() {
    const space = this.requireSelectedSpace();
    if (space.ownership === "user")
      return { done: false, skipped: "user-owned" };
    space.ownership = "user";
    await this.saveState();
    return { done: true };
  }

  async takeOverTaskSpace() {
    const space = this.requireSelectedSpace();
    space.ownership = "agent";
    await this.saveState();
    return { done: true };
  }

  async closeTaskSpace() {
    const space = this.requireSelectedSpace();
    if (this.isTabScopedSpace(space)) {
      for (const targetId of this.spaceTargetIds(space)) {
        await this.closeTarget(targetId).catch(() => {});
      }
    } else if (space.contextId && this.contextIds.has(space.contextId)) {
      await this.connection.request("Target.disposeBrowserContext", {
        browserContextId: space.contextId,
      });
      this.contextIds.delete(space.contextId);
    }
    this.state.spaces = this.state.spaces.filter(
      (candidate) => candidate.id !== space.id,
    );
    this.selectedSpaceId = null;
    this.selectedTargetId = null;
    await this.saveState();
    return { done: true };
  }

  async listTabs() {
    const space = this.currentSpace();
    const contextId = await this.selectedContextId();
    const effectiveContextId = contextId || this.defaultContextId;
    const scopedTargetIds =
      space && this.isTabScopedSpace(space)
        ? new Set(this.spaceTargetIds(space))
        : null;
    const targets = await this.allTargets();
    let tabs = targets.filter((target) => {
      if (target.type !== "page") return false;
      if (isElectronShellTarget(target)) return false;
      if (scopedTargetIds && !scopedTargetIds.has(target.targetId)) {
        return false;
      }
      if (scopedTargetIds) return true;
      return target.browserContextId === effectiveContextId;
    });
    if (tabs.length === 0) {
      const created = await this.createBrowserTab(
        "about:blank",
        space,
        contextId,
      );
      if (space && this.isTabScopedSpace(space)) {
        this.rememberSpaceTarget(space, created.targetId);
        scopedTargetIds?.add(created.targetId);
        await this.saveState();
      }
      this.selectedTargetId = created.targetId;
      tabs = (await this.allTargets()).filter((target) => {
        if (target.type !== "page") return false;
        if (isElectronShellTarget(target)) return false;
        if (scopedTargetIds && !scopedTargetIds.has(target.targetId)) {
          return false;
        }
        if (scopedTargetIds) return true;
        return target.browserContextId === effectiveContextId;
      });
    }
    if (
      !this.selectedTargetId ||
      !tabs.some((tab) => tab.targetId === this.selectedTargetId)
    ) {
      this.selectedTargetId = tabs[0]?.targetId || null;
    }
    return {
      tabs: tabs.map((target, index) => ({
        targetId: target.targetId,
        title: target.title || "",
        url: target.url || "",
        active: target.targetId === this.selectedTargetId,
        index,
      })),
    };
  }

  async createTab(url = "about:blank") {
    const contextId = await this.selectedContextId();
    const result = await this.createBrowserTab(
      url,
      this.currentSpace(),
      contextId,
    );
    const space = this.currentSpace();
    if (space && this.isTabScopedSpace(space)) {
      this.rememberSpaceTarget(space, result.targetId);
      await this.saveState();
    }
    this.selectedTargetId = result.targetId;
    await this.activateTarget(result.targetId);
    return { targetId: result.targetId };
  }

  async attachTarget(targetId) {
    const result = await this.connection.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return result.sessionId;
  }

  async snapshot(options = {}) {
    this.assertControlled();
    const tabs = await this.listTabs();
    const targetId = this.selectedTargetId || tabs[0]?.targetId;
    if (!targetId) return { content: "", refs: [] };
    const sessionId = await this.attachTarget(targetId);
    await this.connection
      .request("Accessibility.enable", {}, sessionId)
      .catch(() => {});
    let result = await this.connection.request(
      "Accessibility.getFullAXTree",
      {},
      sessionId,
    );
    for (
      let attempt = 0;
      attempt < 20 && (result.nodes?.length || 0) <= 3;
      attempt += 1
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const retry = await this.connection.request(
        "Accessibility.getFullAXTree",
        {},
        sessionId,
      );
      if ((retry.nodes?.length || 0) > (result.nodes?.length || 0)) {
        result = retry;
      }
    }
    if (process.env.EGO_LITE_DEBUG === "1") {
      process.stderr.write(
        `[ego-lite-linux] snapshot target=${targetId} session=${sessionId} nodes=${result.nodes?.length || 0}\n`,
      );
    }
    const snapshotNodes =
      options.scope === "only_within_viewport"
        ? await nodesWithinViewport(
            this.connection,
            sessionId,
            result.nodes || [],
          )
        : result.nodes || [];
    const { content, refs } = renderAccessibilityTree(snapshotNodes, options);
    return { content, refs };
  }

  getBrowserVersion() {
    return Promise.resolve({
      currentVersion: HOST_VERSION,
      updateAvailable: false,
    });
  }

  upgradeBrowser() {
    return Promise.resolve({
      ok: true,
      message: "Linux host updates are delivered with the source checkout.",
    });
  }

  animationHighlightMouseToPosition(x, y) {
    if (!this.electronBridge || !this.selectedTargetId) return;
    void this.electronBridge
      .request("/highlight", {
        targetId: this.selectedTargetId,
        x,
        y,
      })
      .catch(() => {});
  }

  setAgentTaskState(label) {
    if (!this.electronBridge) return;
    void this.electronBridge.request("/agent-state", { label }).catch(() => {});
  }

  sendCDPMessage(payload) {
    let message;
    try {
      message = JSON.parse(String(payload));
    } catch {
      this.onSendCDPMessageError?.(
        "invalid CDP payload",
        "EGO_INVALID_ARGUMENT",
      );
      return;
    }
    if (this.isUserControlledMethod(message.method)) {
      queueMicrotask(() =>
        this.onSendCDPMessageError?.(
          "task space is under user control",
          "EGO_TASK_SPACE_USER_IN_CONTROL",
        ),
      );
      return;
    }
    if (
      this.electronBridge &&
      CONTEXT_SCOPED_BROWSER_METHODS.has(message.method)
    ) {
      const operation = this.electronBridge.request("/permissions", {
        targetId: this.selectedTargetId,
        method: message.method,
        params: message.params || {},
      });
      operation
        .then((result) => this.emitCdpResponse(message, result))
        .catch((error) => this.emitCdpResponse(message, null, error));
      return;
    }
    if (
      message.method === "Target.activateTarget" &&
      message.params?.targetId
    ) {
      this.selectedTargetId = message.params.targetId;
    }
    if (
      message.method === "Target.closeTarget" &&
      message.params?.targetId === this.selectedTargetId
    ) {
      this.selectedTargetId = null;
    }
    if (
      this.electronBridge &&
      (message.method === "Target.activateTarget" ||
        message.method === "Target.closeTarget") &&
      message.params?.targetId
    ) {
      const targetId = message.params.targetId;
      if (message.method === "Target.closeTarget") {
        this.removeSpaceTarget(targetId);
        void this.saveState();
      }
      const operation =
        message.method === "Target.activateTarget"
          ? this.activateTarget(targetId)
          : this.closeTarget(targetId);
      operation
        .then(() =>
          this.emitCdpResponse(
            message,
            message.method === "Target.closeTarget" ? { success: true } : {},
          ),
        )
        .catch((error) => this.emitCdpResponse(message, null, error));
      return;
    }
    let outgoingPayload = String(payload);
    if (
      CONTEXT_SCOPED_BROWSER_METHODS.has(message.method) ||
      message.method === "Browser.setDownloadBehavior"
    ) {
      const contextId = this.currentSpace()?.contextId || this.defaultContextId;
      if (
        contextId &&
        !this.isElectron &&
        !(
          this.taskSpaceMode === "tabs" && contextId === this.defaultContextId
        ) &&
        !message.params?.browserContextId
      ) {
        message.params = {
          ...(message.params || {}),
          browserContextId: contextId,
        };
        outgoingPayload = JSON.stringify(message);
      }
    }
    try {
      if (
        message.method === "Accessibility.getFullAXTree" &&
        message.sessionId
      ) {
        this.connection
          .request("Accessibility.enable", {}, message.sessionId)
          .then(() => this.connection.send(outgoingPayload))
          .catch((error) =>
            this.onSendCDPMessageError?.(
              error?.message || String(error),
              "EGO_CDP_SEND_FAILED",
            ),
          );
      } else {
        this.connection.send(outgoingPayload);
      }
    } catch (error) {
      this.onSendCDPMessageError?.(
        error?.message || String(error),
        "EGO_CDP_SEND_FAILED",
      );
    }
  }

  findSpace(id) {
    return (
      this.state.spaces.find(
        (space) => space.id === id || space.name === id || space.taskId === id,
      ) || null
    );
  }

  requireSelectedSpace() {
    const space = this.currentSpace();
    if (!space) fail("no task space selected");
    return space;
  }

  assertControlled() {
    if (this.currentSpace()?.ownership === "user") {
      throw this.error(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "task space is under user control",
      );
    }
  }

  isUserControlledMethod(method) {
    if (!this.currentSpace() || this.currentSpace().ownership !== "user")
      return false;
    return (
      !String(method || "").startsWith("Target.") &&
      !String(method || "").startsWith("Browser.")
    );
  }

  async createBrowserTab(url, space = null, contextId = undefined) {
    if (this.isElectron) {
      if (!this.electronBridge) {
        fail(
          "Electron bridge is unavailable. Restart the ego lite Electron app before creating tabs.",
        );
      }
      return this.electronBridge.request("/create-tab", {
        spaceId: space?.id ?? null,
        spaceName: space?.name ?? null,
        url,
      });
    }
    return this.connection.request("Target.createTarget", {
      url,
      ...this.browserContextParams(contextId),
    });
  }

  async activateTarget(targetId) {
    if (this.isElectron) {
      this.selectedTargetId = targetId;
      return;
    }
    await this.connection.request("Target.activateTarget", { targetId });
  }

  async closeTarget(targetId) {
    if (this.isElectron) {
      if (!this.electronBridge) {
        fail(
          "Electron bridge is unavailable. Restart the ego lite Electron app before closing tabs.",
        );
      }
      await this.electronBridge.request("/close-tab", { targetId });
      return;
    }
    await this.connection.request("Target.closeTarget", { targetId });
  }

  isTabScopedSpace(space) {
    return this.taskSpaceMode === "tabs" || space?.mode === "tab";
  }

  spaceTargetIds(space) {
    return Array.isArray(space?.tabTargetIds) ? space.tabTargetIds : [];
  }

  rememberSpaceTarget(space, targetId) {
    space.tabTargetIds = [
      ...new Set([...this.spaceTargetIds(space), targetId]),
    ];
  }

  removeSpaceTarget(targetId) {
    for (const space of this.state.spaces) {
      space.tabTargetIds = this.spaceTargetIds(space).filter(
        (candidate) => candidate !== targetId,
      );
    }
  }

  emitCdpResponse(message, result, error = null) {
    this.connection.onEvent(
      JSON.stringify({
        id: message.id,
        ...(error
          ? { error: { code: -32000, message: error.message || String(error) } }
          : { result }),
      }),
    );
  }

  browserContextParams(contextId) {
    if (!contextId) return {};
    if (this.taskSpaceMode === "tabs" && contextId === this.defaultContextId) {
      return {};
    }
    return { browserContextId: contextId };
  }

  error(code, message) {
    return { error: message, error_code: code };
  }
}

function axValue(value) {
  if (value && typeof value === "object" && "value" in value)
    return value.value;
  return value;
}

function isElectronShellTarget(target) {
  return String(target?.url || "").includes("/renderer/index.html");
}

function isBrowserContextUnavailable(error) {
  return (
    error?.code === -32000 &&
    /browser context/i.test(String(error?.message || ""))
  );
}

const ACTIONABLE_AX_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

function axPropertyValue(node, propertyName) {
  const property = (node.properties || []).find(
    (candidate) => candidate.name === propertyName,
  );
  return axValue(property?.value);
}

function isActionableAxNode(node, role) {
  return (
    ACTIONABLE_AX_ROLES.has(role) ||
    axValue(node.focusable) === true ||
    axPropertyValue(node, "focusable") === true
  );
}

function stableLocatorForNode(role, name) {
  if (!role || role === "none" || role === "generic" || role === "text") {
    return null;
  }
  return `loc=role:${role}${name ? `[name=${JSON.stringify(name)}]` : ""}`;
}

function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const x = [];
  const y = [];
  for (let index = 0; index < quad.length; index += 2) {
    x.push(Number(quad[index]));
    y.push(Number(quad[index + 1]));
  }
  if (x.some((value) => !Number.isFinite(value))) return null;
  return {
    left: Math.min(...x),
    right: Math.max(...x),
    top: Math.min(...y),
    bottom: Math.max(...y),
  };
}

function boundsIntersectViewport(bounds, viewport) {
  return (
    bounds.right >= viewport.left &&
    bounds.left <= viewport.right &&
    bounds.bottom >= viewport.top &&
    bounds.top <= viewport.bottom
  );
}

async function nodesWithinViewport(connection, sessionId, nodes) {
  if (nodes.length === 0) return nodes;
  let metrics;
  try {
    metrics = await connection.request("Page.getLayoutMetrics", {}, sessionId);
    await connection.request("DOM.enable", {}, sessionId).catch(() => {});
  } catch {
    return nodes;
  }
  const sourceViewport =
    metrics.cssVisualViewport ||
    metrics.cssLayoutViewport ||
    metrics.visualViewport ||
    metrics.layoutViewport;
  const width = Number(
    sourceViewport?.clientWidth ??
      sourceViewport?.width ??
      metrics.cssLayoutViewport?.clientWidth ??
      metrics.layoutViewport?.clientWidth,
  );
  const height = Number(
    sourceViewport?.clientHeight ??
      sourceViewport?.height ??
      metrics.cssLayoutViewport?.clientHeight ??
      metrics.layoutViewport?.clientHeight,
  );
  if (!(width > 0 && height > 0)) return nodes;
  const pageX =
    Number(
      sourceViewport?.pageX ??
        metrics.cssVisualViewport?.pageX ??
        metrics.layoutViewport?.pageX,
    ) || 0;
  const pageY =
    Number(
      sourceViewport?.pageY ??
        metrics.cssVisualViewport?.pageY ??
        metrics.layoutViewport?.pageY,
    ) || 0;
  const viewport = {
    left: pageX,
    top: pageY,
    right: pageX + width,
    bottom: pageY + height,
  };

  const visibleNodeIds = new Set();
  let measuredNodeCount = 0;
  const measurableNodes = nodes.filter(
    (node) => node.backendDOMNodeId !== undefined,
  );
  for (let index = 0; index < measurableNodes.length; index += 32) {
    const batch = measurableNodes.slice(index, index + 32);
    const measurements = await Promise.all(
      batch.map(async (node) => {
        try {
          const result = await connection.request(
            "DOM.getBoxModel",
            { backendNodeId: node.backendDOMNodeId },
            sessionId,
          );
          const model = result.model;
          const bounds =
            quadBounds(model?.border) ||
            quadBounds(model?.content) ||
            quadBounds(model?.padding);
          return bounds ? { nodeId: node.nodeId, bounds } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const measurement of measurements) {
      if (!measurement) continue;
      measuredNodeCount += 1;
      if (boundsIntersectViewport(measurement.bounds, viewport)) {
        visibleNodeIds.add(measurement.nodeId);
      }
    }
  }
  if (measuredNodeCount === 0 || visibleNodeIds.size === 0) return nodes;

  const parentById = new Map();
  for (const node of nodes) {
    for (const childId of node.childIds || []) {
      parentById.set(childId, node.nodeId);
    }
  }
  for (const nodeId of [...visibleNodeIds]) {
    let parentId = parentById.get(nodeId);
    while (parentId) {
      visibleNodeIds.add(parentId);
      parentId = parentById.get(parentId);
    }
  }
  return nodes.filter((node) => visibleNodeIds.has(node.nodeId));
}

function renderAccessibilityTree(nodes, options) {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds || []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const refs = [];
  const seenRefs = new Set();
  const lines = [];
  const maxLength = Number(options.maxResultLength);

  const visit = (node, depth, visited) => {
    if (!node || visited.has(node.nodeId)) return;
    const nextVisited = new Set(visited);
    nextVisited.add(node.nodeId);
    const role = String(axValue(node.role) || "").trim();
    const name = String(axValue(node.name) || "")
      .replace(/\s+/g, " ")
      .trim();
    const backendNodeId = node.backendDOMNodeId;
    const hasUsefulContent =
      !node.ignored &&
      ((role && role !== "none" && role !== "generic") || name);
    if (hasUsefulContent) {
      let line = `${"  ".repeat(depth)}- ${role || "text"}`;
      if (name) line += ` ${JSON.stringify(name)}`;
      const actionable = isActionableAxNode(node, role);
      const annotations = [];
      if (
        options.includeActionMarks !== false &&
        actionable &&
        backendNodeId !== undefined &&
        backendNodeId !== null
      ) {
        annotations.push(`ref=${backendNodeId}`);
        if (!seenRefs.has(backendNodeId)) {
          seenRefs.add(backendNodeId);
          refs.push({
            backendNodeId,
            role: role || "generic",
            name,
          });
        }
      }
      if (options.includeStableLocator !== false && actionable) {
        const stableLocator = stableLocatorForNode(role, name);
        if (stableLocator) annotations.push(stableLocator);
      }
      if (annotations.length > 0) {
        line += ` [${annotations.join(", ")}]`;
      }
      lines.push(line);
    }
    for (const childId of node.childIds || []) {
      visit(
        nodeById.get(childId),
        hasUsefulContent ? depth + 1 : depth,
        nextVisited,
      );
    }
  };

  for (const root of roots) visit(root, 0, new Set());
  let content = lines.join("\n");
  if (
    Number.isFinite(maxLength) &&
    maxLength > 0 &&
    content.length > maxLength
  ) {
    content = `${content.slice(0, maxLength)}\n…`;
  }
  return { content, refs };
}

async function readDevToolsEndpoint(profileDir) {
  try {
    const activePortPath = join(profileDir, "DevToolsActivePort");
    const lines = (await readFile(activePortPath, "utf8"))
      .trim()
      .split(/\r?\n/);
    const port = Number(lines[0]);
    const path = lines[1];
    if (!Number.isInteger(port) || !path) return null;
    return { port, url: `ws://127.0.0.1:${port}${path}` };
  } catch {
    return null;
  }
}

async function canConnect(endpoint) {
  if (!endpoint) return false;
  const connection = new BrowserConnection(endpoint.url);
  try {
    await connection.connect();
    connection.close();
    return true;
  } catch {
    connection.close();
    return false;
  }
}

async function isElectronEndpoint(endpoint) {
  if (!endpoint) return false;
  const connection = new BrowserConnection(endpoint.url);
  try {
    await connection.connect();
    const version = await connection.request("Browser.getVersion");
    return /Electron\//.test(version.userAgent || "");
  } catch {
    return false;
  } finally {
    connection.close();
  }
}

async function readElectronBridge(profileDir) {
  try {
    const bridge = JSON.parse(
      await readFile(join(profileDir, "ego-lite-bridge.json"), "utf8"),
    );
    if (!Number.isInteger(bridge.port) || typeof bridge.token !== "string") {
      return null;
    }
    return new ElectronBridge(bridge);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function profileLooksUsable(profileDir) {
  for (const name of ["Bookmarks", "Preferences", "History"]) {
    if (await pathExists(join(profileDir, name))) return true;
  }
  return false;
}

async function sourceProfileFromUserData(source) {
  const profileDir = join(source.userDataDir, "Default");
  if (!(await profileLooksUsable(profileDir))) return null;
  return {
    name: source.name,
    userDataDir: source.userDataDir,
    profileDir,
    profileName: "Default",
    executableCandidates: source.executableCandidates,
  };
}

async function resolveMigrationSource(sourcePath) {
  if (sourcePath) {
    const candidate = resolve(sourcePath);
    if (await profileLooksUsable(candidate)) {
      return {
        name: "Selected browser",
        userDataDir: dirname(candidate),
        profileDir: candidate,
        profileName: basename(candidate),
        executableCandidates: DEFAULT_EXECUTABLES,
      };
    }
    const defaultProfile = await sourceProfileFromUserData({
      name: "Selected browser",
      userDataDir: candidate,
      executableCandidates: DEFAULT_EXECUTABLES,
    });
    if (defaultProfile) return defaultProfile;
    fail(
      `Chrome profile not found at ${candidate}; pass --from /path/to/Default or a browser user-data directory`,
    );
  }

  const available = [];
  for (const source of MIGRATION_SOURCES) {
    const profile = await sourceProfileFromUserData(source);
    if (profile) available.push(profile);
  }
  if (available.length === 0) {
    fail(
      "no Chromium, Chrome, Chrome Beta, or Brave Default profile was found; pass --from /path/to/Default",
    );
  }
  if (available.length > 1) {
    fail(
      `multiple browser profiles found; choose one with --from: ${available
        .map((profile) => profile.profileDir)
        .join(", ")}`,
    );
  }
  return available[0];
}

async function existingBrowserLock(userDataDir) {
  const lockPath = join(userDataDir, "SingletonLock");
  try {
    const lockTarget = await readlink(lockPath);
    const pidMatch = /-(\d+)$/.exec(lockTarget);
    if (!pidMatch) return "SingletonLock";
    try {
      process.kill(Number(pidMatch[1]), 0);
      return "SingletonLock";
    } catch (error) {
      if (error?.code === "EPERM") return "SingletonLock";
      if (error?.code !== "ESRCH") throw error;
      return null;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

async function ensureProfileNotRunning(userDataDir, label) {
  const lock = await existingBrowserLock(userDataDir);
  if (lock) {
    fail(
      `close ${label} before migration; ${lock} is present in ${userDataDir}`,
    );
  }
  const endpoint = await readDevToolsEndpoint(userDataDir);
  const allowSelfElectron =
    process.env.EGO_LITE_ALLOW_SELF_ELECTRON_MIGRATION === "1" &&
    label === "ego lite" &&
    (await isElectronEndpoint(endpoint));
  if (endpoint && !allowSelfElectron && (await canConnect(endpoint))) {
    fail(`close ${label} before migration; it is still exposing CDP`);
  }
}

async function copyMigrationData(sourceProfileDir, targetProfileDir) {
  const names = [
    ...MIGRATABLE_PROFILE_FILES,
    ...MIGRATABLE_PROFILE_DIRECTORIES,
  ];
  const sourceEntries = [];
  for (const name of names) {
    if (await pathExists(join(sourceProfileDir, name))) {
      sourceEntries.push(name);
    }
  }
  if (sourceEntries.length === 0) {
    fail(`no portable browser data was found in ${sourceProfileDir}`);
  }

  await mkdir(targetProfileDir, { recursive: true });
  const replacedEntries = [];
  for (const name of sourceEntries) {
    if (await pathExists(join(targetProfileDir, name)))
      replacedEntries.push(name);
  }

  let backupDir = null;
  if (replacedEntries.length > 0) {
    backupDir = `${targetProfileDir}.ego-lite-backup-${Date.now()}`;
    await mkdir(backupDir, { recursive: true });
    for (const name of replacedEntries) {
      await cp(join(targetProfileDir, name), join(backupDir, name), {
        recursive: true,
        force: true,
      });
    }
  }

  for (const name of sourceEntries) {
    const targetPath = join(targetProfileDir, name);
    if (await pathExists(targetPath)) {
      await rm(targetPath, { recursive: true, force: true });
    }
    await cp(join(sourceProfileDir, name), targetPath, {
      recursive: true,
      force: true,
    });
  }

  return { copied: sourceEntries, backupDir };
}

async function launchMigrationBrowser({
  executable,
  userDataDir,
  profileName,
  passwordStore,
}) {
  await mkdir(userDataDir, { recursive: true });
  const args = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--noerrdialogs",
  ];
  if (passwordStore) args.push(`--password-store=${passwordStore}`);
  if (process.getuid?.() === 0) args.push("--no-sandbox");

  const logPath = join(userDataDir, "ego-lite-migration.log");
  const logHandle = await open(logPath, "a");
  const child = spawn(executable, args, {
    stdio: ["ignore", logHandle, logHandle],
    env: process.env,
  });
  await logHandle.close();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const endpoint = await readDevToolsEndpoint(userDataDir);
    if (await canConnect(endpoint)) {
      return {
        child,
        connection: await new BrowserConnection(endpoint.url).connect(),
        logPath,
      };
    }
    if (child.exitCode !== null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  await stopMigrationBrowser({ child, connection: null });
  fail(`browser did not expose CDP during migration; see ${logPath}`);
}

async function stopMigrationBrowser(browser) {
  await browser.connection?.request("Browser.close").catch(() => {});
  browser.connection?.close();
  const child = browser.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    let settled = false;
    let forceTimer;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited between the timeout and kill call.
      }
      forceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the timeout and kill call.
        }
        settle();
      }, 2000);
    }, 3000);
    child.once("close", settle);
  });
}

async function attachMigrationTarget(connection) {
  const targets = await connection.request("Target.getTargets");
  let target = (targets.targetInfos || []).find(
    (candidate) => candidate.type === "page",
  );
  if (!target) {
    const created = await connection.request("Target.createTarget", {
      url: "about:blank",
    });
    target = { targetId: created.targetId };
  }
  const attached = await connection.request("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  return attached.sessionId;
}

function migrationCookieParams(cookies) {
  return cookies.map((cookie) => {
    const {
      name,
      value,
      domain,
      path,
      expires,
      httpOnly,
      secure,
      sameSite,
      priority,
      sourceScheme,
      sourcePort,
      partitionKey,
    } = cookie;
    return {
      name,
      value,
      ...(domain ? { domain } : {}),
      ...(path ? { path } : {}),
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
      ...(httpOnly !== undefined ? { httpOnly } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(sameSite ? { sameSite } : {}),
      ...(priority ? { priority } : {}),
      ...(sourceScheme ? { sourceScheme } : {}),
      ...(sourcePort !== undefined ? { sourcePort } : {}),
      ...(partitionKey ? { partitionKey } : {}),
    };
  });
}

async function exportMigrationCookies(source, executable) {
  const browser = await launchMigrationBrowser({
    executable,
    userDataDir: source.userDataDir,
    profileName: source.profileName,
  });
  try {
    const sessionId = await attachMigrationTarget(browser.connection);
    const result = await browser.connection.request(
      "Network.getAllCookies",
      {},
      sessionId,
    );
    return migrationCookieParams(result.cookies || []);
  } finally {
    await stopMigrationBrowser(browser);
  }
}

async function importMigrationCookies(targetUserDataDir, cookies, executable) {
  if (cookies.length === 0) return { imported: 0, failed: 0 };
  const browser = await launchMigrationBrowser({
    executable,
    userDataDir: targetUserDataDir,
    profileName: "Default",
    passwordStore: "basic",
  });
  let imported = 0;
  let failed = 0;
  try {
    const sessionId = await attachMigrationTarget(browser.connection);
    for (const cookie of cookies) {
      try {
        await browser.connection.request(
          "Network.setCookies",
          { cookies: [cookie] },
          sessionId,
        );
        imported += 1;
      } catch {
        failed += 1;
      }
    }
  } finally {
    await stopMigrationBrowser(browser);
  }
  return { imported, failed };
}

async function migrateProfile(sourcePath) {
  const source = await resolveMigrationSource(sourcePath);
  const targetUserDataDir = resolve(
    process.env.EGO_LITE_PROFILE_DIR || DEFAULT_PROFILE_DIR,
  );
  const targetProfileDir = join(targetUserDataDir, "Default");
  if (
    source.userDataDir === targetUserDataDir ||
    source.profileDir === targetProfileDir
  ) {
    fail("source browser profile and ego lite profile must be different");
  }
  await ensureProfileNotRunning(source.userDataDir, `${source.name} browser`);
  await ensureProfileNotRunning(targetUserDataDir, "ego lite");

  const executable = findExecutable(source.executableCandidates);
  const copied = await copyMigrationData(source.profileDir, targetProfileDir);
  const cookies = await exportMigrationCookies(source, executable);
  const imported = await importMigrationCookies(
    targetUserDataDir,
    cookies,
    executable,
  );
  return {
    source: source.profileDir,
    target: targetProfileDir,
    browser: executable,
    copied: copied.copied,
    backupDir: copied.backupDir,
    cookies: {
      found: cookies.length,
      imported: imported.imported,
      failed: imported.failed,
    },
    passwords: "not imported; encrypted browser keyrings are kept separate",
  };
}

function findExecutable(candidates = DEFAULT_EXECUTABLES) {
  const requested = process.env.EGO_BROWSER_EXECUTABLE;
  const executableCandidates = requested ? [requested] : candidates;
  for (const candidate of executableCandidates) {
    const result = spawnSync(
      "sh",
      ["-c", 'command -v "$1"', "ego-lite-find", candidate],
      {
        encoding: "utf8",
      },
    );
    const path = result.status === 0 ? result.stdout.trim() : "";
    if (path) return path;
  }
  fail(
    "Chromium was not found. Install Chromium/Chrome or set EGO_BROWSER_EXECUTABLE to its executable path.",
  );
}

async function launchChromium(profileDir) {
  const executable = findExecutable();
  await mkdir(profileDir, { recursive: true });
  const headless =
    process.env.EGO_LITE_HEADLESS === "1" ||
    process.env.EGO_LITE_HEADLESS === "true" ||
    (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  const args = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--enable-automation",
    "--window-size=1440,900",
  ];
  if (headless)
    args.push("--headless=new", "--disable-gpu", "--disable-dev-shm-usage");
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const extraArgs = process.env.EGO_LITE_CHROMIUM_ARGS_JSON;
  if (extraArgs) {
    let parsed;
    try {
      parsed = JSON.parse(extraArgs);
    } catch {
      fail(
        "EGO_LITE_CHROMIUM_ARGS_JSON must be a JSON array of Chromium arguments",
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((arg) => typeof arg !== "string")
    ) {
      fail("EGO_LITE_CHROMIUM_ARGS_JSON must be a JSON array of strings");
    }
    args.push(...parsed);
  }
  const logPath = join(dirname(profileDir), "chromium.log");
  const logHandle = await import("node:fs/promises").then(({ open }) =>
    open(logPath, "a"),
  );
  const child = spawn(executable, args, {
    detached: true,
    stdio: ["ignore", logHandle, logHandle],
    env: process.env,
  });
  child.unref();
  await logHandle.close();
  const deadline =
    Date.now() + Number(process.env.EGO_LITE_LAUNCH_TIMEOUT_MS || 15000);
  while (Date.now() < deadline) {
    const endpoint = await readDevToolsEndpoint(profileDir);
    if (await canConnect(endpoint)) return endpoint;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail(`Chromium started but did not expose CDP in time. See ${logPath}`);
}

async function connectToChromium() {
  const profileDir = process.env.EGO_LITE_PROFILE_DIR || DEFAULT_PROFILE_DIR;
  let endpoint = await readDevToolsEndpoint(profileDir);
  let connection;
  if (endpoint) {
    connection = new BrowserConnection(endpoint.url);
    try {
      await connection.connect();
    } catch {
      connection.close();
      connection = null;
    }
  }
  if (!connection) {
    endpoint = await launchChromium(profileDir);
    connection = await new BrowserConnection(endpoint.url).connect();
  }
  const statePath = process.env.EGO_LITE_STATE_PATH || DEFAULT_STATE_PATH;
  const version = await connection
    .request("Browser.getVersion")
    .catch(() => ({}));
  const electronBridge = /Electron\//.test(version.userAgent || "")
    ? await readElectronBridge(profileDir)
    : null;
  const host = await new LinuxEgoHost(connection, {
    profileDir,
    statePath,
    browserVersion: version.product || "Chromium",
    browserUserAgent: version.userAgent || "",
    electronBridge,
  }).init();
  return host;
}

async function findSdkPath(explicit) {
  const candidates = [
    explicit,
    process.env.EGO_BROWSER_SDK_PATH,
    join(INSTALL_DIR, "sdk", "index.js"),
    join(REPO_DIR, "package", "ego-browser", "dist", "out", "index.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return resolve(candidate);
    } catch {
      // Try the next installation layout.
    }
  }
  fail(
    "The ego-browser SDK is not built. Run `cd package/ego-browser && npm ci && npm run build`, then retry.",
  );
}

async function readStdin() {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

function parseArgs(argv) {
  const args = [...argv];
  let sdkPath;
  let migrateFrom;
  let command = "run";
  if (args[0] === "nodejs") args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sdk-path") {
      sdkPath = args[++index];
      if (!sdkPath) fail("--sdk-path requires a path");
    } else if (arg === "--doctor") {
      command = "doctor";
    } else if (arg === "--launch") {
      command = "launch";
    } else if (arg === "--reload") {
      command = "reload";
    } else if (arg === "--migrate-profile") {
      command = "migrate-profile";
    } else if (arg === "--from") {
      migrateFrom = args[++index];
      if (!migrateFrom) fail("--from requires a path");
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { command, sdkPath, migrateFrom };
}

export async function runHost(argv = process.argv.slice(2)) {
  const { command, sdkPath, migrateFrom } = parseArgs(argv);
  if (command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "reload") {
    const profileDir = process.env.EGO_LITE_PROFILE_DIR || DEFAULT_PROFILE_DIR;
    const endpoint = await readDevToolsEndpoint(profileDir);
    if (endpoint && (await canConnect(endpoint))) {
      process.stdout.write(
        "Chromium is already running; the next command will reconnect.\n",
      );
    } else {
      process.stdout.write(
        "No running Linux browser connection found; the next command will launch Chromium.\n",
      );
    }
    return 0;
  }
  if (command === "migrate-profile") {
    const report = await migrateProfile(migrateFrom);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const host = await connectToChromium();
  if (command === "doctor") {
    const tabs = await host.listTabs();
    process.stdout.write(
      `${JSON.stringify(
        {
          platform: "linux",
          browser: host.browserVersion,
          taskSpaceMode: host.taskSpaceMode,
          executable:
            process.env.EGO_BROWSER_EXECUTABLE || "auto-detected Chromium",
          profileDir: host.profileDir,
          statePath: host.statePath,
          tabs: tabs.tabs,
        },
        null,
        2,
      )}\n`,
    );
    host.connection.close();
    return 0;
  }
  if (command === "launch") {
    process.stdout.write(
      `ego lite Linux is running Chromium from ${host.profileDir}\n`,
    );
    host.connection.close();
    return 0;
  }
  const source = await readStdin();
  if (!source.trim()) {
    process.stderr.write(HELP);
    host.connection.close();
    return 2;
  }
  const sdkPathValue = await findSdkPath(sdkPath);
  const agentWorkspace =
    process.env.EGO_BROWSER_AGENT_WORKSPACE ||
    (existsSync(join(INSTALL_DIR, "ego-browser"))
      ? join(INSTALL_DIR, "ego-browser")
      : join(REPO_DIR, "skills", "ego-browser"));
  process.env.EGO_BROWSER_AGENT_WORKSPACE = agentWorkspace;
  const sdk = await import(pathToFileURL(sdkPathValue).href);
  globalThis.ego = host;
  sdk.installEgoSdk(globalThis);
  try {
    return await sdk.runMain({ argv: [], stdinText: source });
  } finally {
    host.connection.close();
  }
}

function isDirectExecution() {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

export { nodesWithinViewport, renderAccessibilityTree };

if (isDirectExecution()) {
  try {
    process.exitCode = await runHost();
  } catch (error) {
    process.stderr.write(
      `${error?.stack || error?.message || String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
