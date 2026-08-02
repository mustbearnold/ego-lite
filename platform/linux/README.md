# ego lite Linux host

This directory contains the open Linux host for the `ego-browser` SDK. It launches a user-local Chromium/Chrome process with a persistent profile, connects to its browser-level CDP websocket, and supplies the `globalThis.ego` bridge expected by `package/ego-browser`.

The host is dependency-free beyond Node.js 22+. It uses Chromium browser contexts for task spaces, copies current browser cookies into a new agent context when possible, and persists task-space metadata under `~/.local/state/ego-lite/task-spaces.json`.

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

```bash
cd platform/electron
npm install
npm run package:linux
```

## Runtime configuration

`EGO_BROWSER_EXECUTABLE` selects Chromium/Chrome explicitly. `EGO_LITE_PROFILE_DIR` changes the persistent browser profile, and `EGO_LITE_STATE_PATH` changes task-space metadata. `EGO_LITE_HEADLESS=1` enables headless Chromium; `EGO_LITE_CHROMIUM_ARGS_JSON` accepts an extra JSON array of Chromium arguments.

The default profile is separate from an existing Chrome profile. To migrate portable browser data explicitly, close the source browser and run:

```bash
ego-lite --migrate-profile --from "$HOME/.config/google-chrome"
```

`--from` accepts a Chromium/Chrome/Brave user-data directory or a specific profile directory such as `.../Default`. The migration backs up replaced ego lite data, copies bookmarks, settings, extensions, local storage, and related browser databases, and transfers readable cookies through a temporary CDP session. Passwords are not copied because Chrome's encrypted keyring is separate and must not be transplanted blindly. If `--from` is omitted, the host auto-detects a single supported Chromium-family profile.

## Compatibility boundary

The helper SDK, CDP transport, task-space ownership methods, screenshots, downloads, uploads, locators, and semantic refs are shared with the macOS runtime. Snapshots are rendered from Chromium's `Accessibility.getFullAXTree`; Linux honors full-page versus viewport scope, action marks, stable role locators, and result limits, while wording and coverage can still differ from the macOS app's custom snapshot engine.

The Linux host forwards `Browser.grantPermissions`, `Browser.resetPermissions`, and `Browser.setPermission` through the task-space bridge. The standalone host scopes these commands to the active Chromium browser context. The Electron package applies them to the active `BrowserView` session through its authenticated bridge while task spaces use separate persistent sessions; a new empty task partition inherits cookies from the primary visible session, then remains isolated. Electron task views stay in the background until the user reveals one from the toolbar picker. Electron's public CDP endpoint does not expose browser-context creation. The visible Linux browser is stock Chromium/Electron rather than the upstream closed-source ego lite Chromium shell, so app-specific browser chrome and the macOS custom snapshot engine remain outside this port.
