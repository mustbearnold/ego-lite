#!/usr/bin/env node

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const HOST_VERSION = "linux-host/0.3.0";
const nativeFetch = globalThis.fetch?.bind(globalThis);
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
  ego-browser nodejs [--sdk-path PATH]

Environment:
  EGO_BROWSER_EXECUTABLE       Chromium/Chrome executable to launch
  EGO_LITE_PROFILE_DIR         Persistent browser profile directory
  EGO_LITE_HEADLESS=1          Run Chromium headlessly (useful in CI)
  EGO_BROWSER_AGENT_WORKSPACE  Skill workspace used by the SDK
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
    const cookies = await this.connection.request("Network.getAllCookies");
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
    const { content, refs } = renderAccessibilityTree(
      result.nodes || [],
      options,
    );
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

  animationHighlightMouseToPosition() {}

  setAgentTaskState() {}

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
      if (backendNodeId !== undefined && backendNodeId !== null) {
        line += ` [ref=${backendNodeId}]`;
        if (!seenRefs.has(backendNodeId)) {
          seenRefs.add(backendNodeId);
          refs.push({
            backendNodeId,
            role: role || "generic",
            name,
          });
        }
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

function findExecutable() {
  const requested = process.env.EGO_BROWSER_EXECUTABLE;
  const candidates = requested
    ? [requested]
    : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const candidate of candidates) {
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
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { command, sdkPath };
}

export async function runHost(argv = process.argv.slice(2)) {
  const { command, sdkPath } = parseArgs(argv);
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
