import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAppleScript, projectAppleScriptResponse } from "../../linux/apple-script.mjs";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const hostPath = resolve(repoDir, "platform/linux/ego-browser.mjs");
const sdkPath = resolve(repoDir, "package/ego-browser/dist/out/index.js");
const packagedExecutable = process.env.EGO_LITE_ELECTRON_EXECUTABLE;
const electronPath = resolve(
  packagedExecutable || resolve(testDir, "../node_modules/.bin/electron"),
);
const electronArguments = packagedExecutable
  ? ["--cli", "--applescript"]
  : ["platform/electron", "--cli", "--applescript"];
const executable = process.env.EGO_BROWSER_EXECUTABLE || "chromium";

const standaloneRoot = await mkdtemp(join(tmpdir(), "ego-applescript-standalone-"));
const standaloneProfile = join(standaloneRoot, "chromium-profile");
const standaloneState = join(standaloneRoot, "task-spaces.json");
const electronRoot = await mkdtemp(join(tmpdir(), "ego-applescript-electron-"));
const electronProfile = join(electronRoot, "chromium-profile");
const electronState = join(electronRoot, "task-spaces.json");
let fixtureServer;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseJsonOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Electron may print diagnostic lines before the JSON response.
    }
  }
  throw new Error(`CLI did not emit JSON:\n${stdout}`);
}

function runProcess(command, args, env, source) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`AppleScript CLI timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
    child.stdin.end(source);
  });
}

function standaloneEnvironment() {
  return {
    ...process.env,
    EGO_LITE_PROFILE_DIR: standaloneProfile,
    EGO_LITE_STATE_PATH: standaloneState,
    EGO_LITE_HEADLESS: "1",
    EGO_LITE_DISABLE_GPU: "1",
    EGO_LITE_SKIP_MIGRATION: "1",
    EGO_LITE_DISABLE_AUTO_UPDATE: "1",
    EGO_BROWSER_EXECUTABLE: executable,
  };
}

function electronEnvironment() {
  return {
    ...process.env,
    EGO_LITE_PROFILE_DIR: electronProfile,
    EGO_LITE_STATE_PATH: electronState,
    ...(packagedExecutable ? {} : { EGO_BROWSER_SDK_PATH: sdkPath }),
    EGO_LITE_DISABLE_GPU: "1",
    EGO_LITE_SKIP_MIGRATION: "1",
    EGO_LITE_DISABLE_AUTO_UPDATE: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    WAYLAND_DISPLAY: "",
    XDG_SESSION_TYPE: "x11",
  };
}

async function runStandalone(source) {
  const result = await runProcess(
    process.execPath,
    [hostPath, "--applescript"],
    standaloneEnvironment(),
    source,
  );
  assert.equal(
    result.code,
    0,
    `standalone AppleScript failed (${result.signal || "no signal"})\n${result.stdout}\n${result.stderr}`,
  );
  return parseJsonOutput(result.stdout);
}

async function waitForStandaloneResponse(source, predicate, label) {
  const deadline = Date.now() + 5_000;
  let response;
  while (Date.now() < deadline) {
    response = await runStandalone(source);
    if (predicate(response)) return response;
    await sleep(100);
  }
  throw new Error(
    `standalone AppleScript ${label} did not settle:\n${JSON.stringify(response)}`,
  );
}

async function runElectron(source) {
  const result = await runProcess(
    electronPath,
    electronArguments,
    electronEnvironment(),
    source,
  );
  assert.equal(
    result.code,
    0,
    `Electron AppleScript failed (${result.signal || "no signal"})\n${result.stdout}\n${result.stderr}`,
  );
  return parseJsonOutput(result.stdout);
}

async function runTypedStandalone(request) {
  const result = await runProcess(
    process.execPath,
    [hostPath, "--automation"],
    standaloneEnvironment(),
    `${JSON.stringify(request)}\n`,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return parseJsonOutput(result.stdout);
}

async function closeStandaloneChromium() {
  let endpoint;
  try {
    const lines = (await readFile(join(standaloneProfile, "DevToolsActivePort"), "utf8"))
      .trim()
      .split(/\r?\n/);
    endpoint = `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
  } catch {
    return;
  }
  const socket = new WebSocket(endpoint);
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", rejectPromise, { once: true });
  });
  let id = 1;
  socket.send(JSON.stringify({ id, method: "Browser.close" }));
  await sleep(100);
  socket.close();
}

function tell(command, application = "ego lite") {
  return `tell application "${application}"\n  ${command}\nend tell\n`;
}

try {
  const getUrl = parseAppleScript(tell("get URL of tab 1 of window 1"));
  assert.equal(getUrl.ok, true);
  assert.deepEqual(getUrl.request, { version: 1, action: "state", params: {} });
  assert.equal(getUrl.projection.property, "url");
  assert.equal(getUrl.projection.selector.index, 1);

  const countTabs = parseAppleScript("count tabs");
  assert.deepEqual(countTabs.request, {
    version: 1,
    action: "standard.count",
    params: { kind: "tabs" },
  });
  assert.equal(
    projectAppleScriptResponse(
      { version: 1, ok: true, result: { count: 3 } },
      countTabs.projection,
    ).result.value,
    3,
  );
  const scopedCount = parseAppleScript("count tabs of window 1");
  assert.deepEqual(scopedCount.request, {
    version: 1,
    action: "state",
    params: {},
  });
  assert.equal(scopedCount.projection.type, "count");
  const lastTab = parseAppleScript("get URL of last tab");
  assert.equal(lastTab.projection.selector.last, true);
  const reloadLast = parseAppleScript("reload last tab");
  assert.deepEqual(reloadLast.request, {
    version: 1,
    action: "tab.reload",
    params: { last: true },
  });
  const collectionProperty = parseAppleScript("get URL of every tab");
  assert.equal(collectionProperty.projection.property, "url");
  const multi = parseAppleScript(tell("get URL of tab 1\nget title of tab 1"));
  assert.equal(multi.ok, true);
  assert.equal(multi.statementCount, 2);
  assert.deepEqual(
    multi.statements.map((statement) => statement.request.action),
    ["state", "state"],
  );
  const invalidMulti = parseAppleScript(
    tell("get URL of active tab\nget unsupported thing"),
  );
  assert.equal(invalidMulti.ok, false);
  assert.equal(invalidMulti.error.details.statementIndex, 1);
  assert.equal(
    parseAppleScript('tell application "Mail"\nget name\nend tell').error.code,
    "EGO_APPLESCRIPT_UNSUPPORTED_APPLICATION",
  );
  assert.deepEqual(
    parseAppleScript('set URL of active tab to "https://example.com"').request,
    {
      version: 1,
      action: "tab.navigate",
      params: { active: true, url: "https://example.com" },
    },
  );

  fixtureServer = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const pages = {
      "/one": ["AppleScript One", "APPLE_SCRIPT_ONE"],
      "/two": ["AppleScript Two", "APPLE_SCRIPT_TWO"],
    };
    const [title, marker] = pages[path] || ["AppleScript Blank", "APPLE_SCRIPT_BLANK"];
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><main>${marker}</main>`);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    fixtureServer.once("error", rejectPromise);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = fixtureServer.address().port;
  const oneUrl = `http://127.0.0.1:${port}/one`;
  const twoUrl = `http://127.0.0.1:${port}/two`;

  const opened = await runStandalone(tell(`open "${oneUrl}"`, "Chromium"));
  assert.equal(opened.ok, true);
  const standaloneUrl = await runStandalone(tell("get URL of active tab of window 1"));
  assert.equal(standaloneUrl.result.value, oneUrl);
  const standaloneTitle = await waitForStandaloneResponse(
    tell("get title of active tab"),
    (response) => response.result?.value === "AppleScript One",
    "title",
  );
  assert.equal(standaloneTitle.result.value, "AppleScript One");
  const standaloneMulti = await runStandalone(
    tell(`open "${oneUrl}"\nget URL of active tab`, "Chromium"),
  );
  assert.equal(standaloneMulti.ok, true);
  assert.equal(standaloneMulti.result.value, oneUrl);
  assert.equal(standaloneMulti.script.statements, 2);
  const standaloneCount = await runStandalone("count tabs");
  assert.ok(standaloneCount.result.value >= 1);
  const standaloneWindowCount = await runStandalone(
    tell("count tabs of window 1"),
  );
  assert.equal(
    standaloneWindowCount.result.value,
    standaloneCount.result.value,
  );
  const standaloneUrls = await runStandalone(
    tell("get URL of every tab of window 1"),
  );
  assert.ok(Array.isArray(standaloneUrls.result.value));
  assert.ok(standaloneUrls.result.value.includes(oneUrl));
  const standaloneLastUrl = await runStandalone(
    tell("get URL of last tab"),
  );
  assert.ok(standaloneUrls.result.value.includes(standaloneLastUrl.result.value));
  const standaloneReloadLast = await runStandalone(
    tell("reload last tab\nget URL of last tab"),
  );
  assert.equal(standaloneReloadLast.result.value, standaloneLastUrl.result.value);
  const standaloneExists = await runStandalone("exists active tab");
  assert.equal(standaloneExists.result.value, true);
  const standaloneApplicationExists = await runStandalone("exists application");
  assert.equal(standaloneApplicationExists.result.value, true);
  const standaloneExecute = await runStandalone(
    tell('execute active tab javascript "document.querySelector(\\\'main\\\').textContent"'),
  );
  assert.equal(standaloneExecute.result.value, "APPLE_SCRIPT_ONE");
  await runStandalone(tell(`set URL of active tab to "${twoUrl}"`));
  await sleep(250);
  const navigated = await runStandalone(tell("get URL of active tab"));
  assert.equal(navigated.result.value, twoUrl);

  const electronOpened = await runElectron(tell(`open "${oneUrl}"`));
  assert.equal(electronOpened.ok, true);
  assert.equal(electronOpened.result.tab.url, oneUrl);
  const electronMulti = await runElectron(
    tell(`open "${oneUrl}"\nget URL of active tab`, "Chromium"),
  );
  assert.equal(electronMulti.ok, true);
  assert.equal(electronMulti.result.value, oneUrl);
  assert.equal(electronMulti.script.statements, 2);
  const electronUrls = await runElectron(
    tell(`open "${oneUrl}"\nget URL of every tab of window 1`),
  );
  assert.ok(Array.isArray(electronUrls.result.value));
  assert.ok(electronUrls.result.value.includes(oneUrl));
  assert.equal(electronUrls.script.statements, 2);
  const electronLastUrl = await runElectron(
    tell(`open "${oneUrl}"\nget URL of last tab`),
  );
  assert.equal(electronLastUrl.result.value, oneUrl);
  assert.equal(electronLastUrl.script.statements, 2);
  const electronReloadLast = await runElectron(
    tell(`open "${oneUrl}"\nreload last tab\nget URL of last tab`),
  );
  assert.equal(electronReloadLast.result.value, oneUrl);
  assert.equal(electronReloadLast.script.statements, 3);
  const electronApplicationExists = await runElectron("exists application");
  assert.equal(electronApplicationExists.result.value, true);
  const electronUrl = { result: { value: electronOpened.result.tab.url } };
  const electronVisible = await runElectron(tell("get visible of window 1"));
  assert.equal(electronVisible.result.value, false);
  const electronName = await runElectron(tell("get name of window 1"));
  assert.equal(electronName.result.value, "ego lite");
  await runElectron(tell('set name of window 1 to "AppleScript Window"'));
  const renamed = await runElectron(tell("get name of window 1"));
  assert.equal(renamed.result.value, "AppleScript Window");
  const electronExecute = await runElectron(
    tell('execute active tab javascript "document.title"'),
  );
  assert.equal(typeof electronExecute.result.value, "string");

  console.log(
    JSON.stringify({
      parser: "ok",
      standalone: { url: standaloneUrl.result.value, navigated: navigated.result.value },
      electron: { url: electronUrl.result.value, windowName: renamed.result.value },
    }),
  );
} finally {
  fixtureServer?.close();
  await closeStandaloneChromium().catch(() => {});
  await rm(standaloneRoot, { recursive: true, force: true }).catch(() => {});
  await rm(electronRoot, { recursive: true, force: true }).catch(() => {});
}
