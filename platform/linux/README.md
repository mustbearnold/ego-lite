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

The default profile is separate from an existing Chrome profile. Linux Chrome password/cookie stores are encrypted and may be live-locked, so automatic profile migration is not attempted; sign in once in the ego lite Linux profile instead.

## Compatibility boundary

The helper SDK, CDP transport, task-space ownership methods, screenshots, downloads, uploads, locators, and semantic refs are shared with the macOS runtime. Snapshots are rendered from Chromium's `Accessibility.getFullAXTree`, so they are compatible with the existing backend-node resolver but can differ in wording and coverage from the macOS app's custom snapshot engine.

The Linux host forwards `Browser.grantPermissions`, `Browser.resetPermissions`, and `Browser.setPermission` through the task-space bridge. The standalone host scopes these commands to the active Chromium browser context. The Electron package applies them to the active `BrowserView` session through its authenticated bridge while task spaces use separate persistent sessions; Electron's public CDP endpoint does not expose browser-context creation. The visible Linux browser is stock Chromium/Electron rather than the upstream closed-source ego lite Chromium shell, so app-specific browser chrome and Chrome-data migration are outside this port.
