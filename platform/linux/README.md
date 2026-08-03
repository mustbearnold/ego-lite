# ego lite Linux host

This directory contains the open Linux host for the `ego-browser` SDK. It launches a user-local Chromium/Chrome process with a persistent profile, connects to its browser-level CDP websocket, and supplies the `globalThis.ego` bridge expected by `package/ego-browser`.

The host is dependency-free beyond Node.js 22+. It uses Chromium browser contexts for task spaces, copies current browser cookies into a new agent context when possible, and persists task-space metadata under `~/.local/state/ego-lite/task-spaces.json`.

Pass `--profile NAME` or set `EGO_LITE_PROFILE_ID` to select a persistent browser profile. Pass `--server-name NAME` or set `EGO_LITE_SERVER_NAME` to run or reconnect to a named browser instance. Profile and named-instance namespaces compose, so `--profile work --server-name ci` uses separate `profiles/work` data below the `servers/ci` roots. The default profile and server keep the existing paths for backwards compatibility.

## Install

From the repository root:

```bash
sh skills/ego-browser/scripts/install.sh
```

The installer builds the SDK and installs the host, skill, desktop entry, and user-local commands. It does not modify `/usr` or require `sudo`.

For a development checkout without installing:

```bash
cd package/ego-browser
npm ci
npm run build
cd ../..
EGO_LITE_HEADLESS=1 node platform/linux/ego-browser.mjs --doctor
```

For an embedded Chromium desktop package, use the Electron project in
`platform/electron`. It produces an unpacked Linux app plus AppImage, Debian,
and RPM artifacts and includes the host, SDK, and skill resources.

The standalone desktop command accepts the same external targets as the desktop
launcher. Use `ego-lite --launch https://example.com` or
`ego-lite --launch /absolute/path/to/page.html`; multiple HTTP(S) URLs and local
files open as primary tabs, with the final target active. The installed desktop
entry passes `%U` and registers HTTP, HTTPS, file, HTML, and XHTML associations.

The Linux host also exposes a stable one-shot automation contract. Send one
JSON request on stdin and read one JSON response from stdout:

```bash
printf '%s\n' '{"version":1,"action":"state"}' | ego-lite --automation
printf '%s\n' '{"version":1,"action":"tab.create","params":{"url":"https://example.com"}}' | ego-lite --automation
```

Responses always contain `version: 1` and `ok`; failures use a stable
`error.code`. Supported actions cover typed standard-suite equivalents
(`application.open`, `application.print`, `application.quit`, and
`standard.count`, `standard.exists`, `standard.delete`, `standard.duplicate`,
`standard.make`, and `standard.move`), window and Space inspection, tab creation,
activation, closing, navigation, reload/stop, muting, editing
(`tab.undo`, `tab.redo`, `tab.cut`, `tab.copy`, `tab.paste`, and
`tab.select-all`), JavaScript execution, page save, PDF print, view source, and
bookmark list/add/remove/open/toggle plus nested folder add/rename/remove and
move/reorder.
Window state includes macOS-shaped name, bounds, capability, active-tab, and
mode fields; bookmark mutations are mirrored to an ego-owned profile store so
they survive Chromium shutdown; native window mutations remain Electron-only.
Standard tab selectors accept ids, names/titles, URLs, 1-based indices, and
nested `specifier` records; bookmark selectors additionally accept nested
folder paths. The standard suite accepts the AppleScript-shaped `each`, `new`,
`at`, and `to` location aliases. `standard.move` moves a tab between the
primary scope and a named or numeric Agent Space; standalone requests can add
`sourceSpaceId` when the source is outside the selected scope. Cross-Space
moves recreate the tab from its URL to retain the storage isolation boundary,
so transient page state is not promised to survive the move.
`tab.execute` takes
`params.javascript`; `tab.save` and `tab.print` require `params.path` when
running standalone. When attached to Electron, the CLI uses the authenticated
bridge and reports the complete managed-tab inventory. Against standalone
Chromium it reports the active scope and uses CDP for the same tab actions
where Chromium exposes them.

Tagged AppImage releases check for updates in the background and apply a downloaded update on the next launch; Debian and RPM installations use their package-manager update path. Set `EGO_LITE_DISABLE_AUTO_UPDATE=1` for offline or automated runs.

```bash
cd platform/electron
npm install
npm run package:linux
```

The checkout installer offers the same migration during an interactive first install when it finds exactly one supported Chromium-family profile. Use `EGO_LITE_SKIP_MIGRATION=1` for unattended installs.

## Runtime configuration

`EGO_BROWSER_EXECUTABLE` selects Chromium/Chrome explicitly. `EGO_LITE_PROFILE_ROOT` changes the root used for named Linux profiles, while `EGO_LITE_PROFILE_DIR` and `EGO_LITE_STATE_PATH` override the resolved browser profile and task-space metadata paths. `EGO_LITE_HEADLESS=1` enables headless Chromium; `EGO_LITE_CHROMIUM_ARGS_JSON` accepts an extra JSON array of Chromium arguments.

The default profile is separate from an existing Chrome profile. To migrate portable browser data explicitly, close the source browser and run:

```bash
ego-lite --migrate-profile --from "$HOME/.config/google-chrome"
```

`--from` accepts a Chromium/Chrome/Brave user-data directory or a specific profile directory such as `.../Default`. The migration backs up replaced ego lite data, copies bookmarks, settings, extensions, local storage, related browser databases, and passwords from Chromium’s basic plaintext store, transfers readable cookies through a temporary CDP session, and records restorable HTTP(S) tabs plus tab-group metadata in `ego-lite-migrated-tabs.json`. Keyring-backed passwords are not copied because their encryption belongs to the source desktop keyring. If `--from` is omitted, the host auto-detects a single supported Chromium-family profile.

The Electron package also exposes the same migration from its toolbar Import button. That path queues the selected source, restarts the package before copying profile data, and retains the target backup if existing files are replaced.

## Compatibility boundary

The helper SDK, CDP transport, task-space ownership methods, screenshots, downloads, uploads, locators, and semantic refs are shared with the macOS runtime. Snapshots are rendered from Chromium's `Accessibility.getFullAXTree`; Linux walks the page frame tree so nested and cross-origin iframe content is included, preserves frame ownership on actionable refs, and honors full-page versus viewport scope, action marks, stable role locators across frame content, and result limits. Wording and some coverage can still differ from the macOS app's custom snapshot engine.

The Linux host forwards `Browser.grantPermissions`, `Browser.resetPermissions`, and `Browser.setPermission` through the task-space bridge. The standalone host scopes these commands to the active Chromium browser context. The Electron package applies them to the active `BrowserView` session through its authenticated bridge while task spaces use separate persistent sessions; a new empty task partition inherits cookies from the primary visible session, then remains isolated. Electron persists primary tabs, migrated group metadata, and background task-Space tabs in separate session manifests, rebinding restored Space views to fresh CDP target IDs after restart while keeping them hidden until the user reveals one from the toolbar picker. Electron's public CDP endpoint does not expose browser-context creation. The visible Linux browser is stock Chromium/Electron rather than the upstream closed-source ego lite Chromium shell, so app-specific browser chrome and the macOS custom snapshot engine remain outside this port.

The Electron toolbar also exposes imported Chromium bookmarks and supports non-persistent private tabs. Private tabs use a temporary Chromium partition, do not inherit primary-session cookies, and are omitted from primary-tab restoration.

Primary-tab downloads are tracked in the Electron toolbar and saved under `EGO_LITE_DOWNLOAD_DIR` when configured, or the normal user Downloads directory. Agent task-Space downloads continue to use the SDK/CDP download path.

When using Electron, SDK pointer labels are reflected in the toolbar, the live control badge follows Space handoff/takeover ownership, and labeled coordinates receive a transient page-local highlight. The standalone Chromium host keeps the browser interaction contract but has no ego lite toolbar surface for that status display.
