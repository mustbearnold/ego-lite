# ego lite Electron package

This directory packages the Linux port as a desktop Electron application. Electron is the selected desktop runtime because the Linux host already speaks Chromium's browser-level CDP; the existing SDK and task-space bridge can attach to the embedded browser without a second browser process.

## Development

```bash
cd platform/electron
npm install
npm start
```

The app uses the same profile as the Linux host by default: `~/.local/share/ego-lite/chromium-profile`. Start the Electron app before using `ego-browser` so the host attaches to Electron's CDP endpoint instead of launching a separate Chromium process.

## Packaging

Build the unpacked Linux application:

```bash
npm run package:dir
```

Build a portable AppImage:

```bash
npm run package:appimage
```

Build the full x64 Linux distribution set (AppImage, Debian package, and RPM):

```bash
npm run package:linux
```

The RPM target requires `rpmbuild`: install `rpm-tools` on Arch-based systems or `rpm` on Debian/Ubuntu.

The package includes the Linux host, built SDK, and `ego-browser` skill under its resources. Sign in through the primary visible tab; each new task Space starts with a cookie snapshot from that session, then keeps its own persistent cookie jar. The packaged executable also accepts `--cli`, so a smoke check can use `ego-lite --cli --doctor` or run the SDK through `ego-lite --cli nodejs`. Linux artifacts are written to `platform/electron/dist/`.

Tagged AppImage releases use `electron-updater`: the packaged app checks for updates in the background, downloads them without interrupting the current session, and applies a ready update on the next launch. Debian and RPM installations continue to follow their package-manager update path. Set `EGO_LITE_DISABLE_AUTO_UPDATE=1` for offline or detached test runs.

On the first packaged-app launch, when a supported Chromium-family profile is found and the ego lite profile is still empty, a one-time migration prompt offers to copy portable browser data before the browser window opens. If multiple profiles are found, the prompt first asks you to choose one profile directory. Set `EGO_LITE_SKIP_MIGRATION=1` for unattended launches; choosing to keep profiles separate records the decision in the target profile. Passwords from Chromium’s basic plaintext store are copied; keyring-backed passwords remain excluded.

The toolbar’s Import button provides the repeatable Settings → Import data path. It opens a directory chooser for a Chromium-family user-data directory or profile, saves the request, restarts the app, performs the guarded migration before the new window opens, restores imported HTTP(S) tabs and groups, and backs up replaced target data. Close the source browser first; basic-store passwords are copied while keyring-backed passwords remain excluded.

The Profile menu keeps the existing default profile at `~/.local/share/ego-lite/chromium-profile`, stores additional profiles under `~/.local/share/ego-lite/profiles/`, and restarts into the selected profile. Each profile has independent browser data, task-space state, extensions, tabs, and window state; new profiles start empty and can use Import data later.

Agent-created task tabs stay in the background by default, so creating or navigating a Space does not replace the user’s visible tab. Use the toolbar’s tab picker to inspect or reveal a Space explicitly.

The toolbar exposes bookmarks imported into the Electron profile and a Private tab action. Private tabs use an in-memory Chromium partition, do not inherit the primary tab’s cookies, and are not written to the primary session manifest. `Ctrl/Cmd+Shift+N` opens one from the toolbar or a focused page; `Ctrl/Cmd+T` and `Ctrl/Cmd+W` continue to create and close ordinary tabs.

`Ctrl/Cmd+F` opens the native Find in Page bar. It reports the current match count, supports next/previous navigation and Escape/close, and searches the active BrowserView through Chromium’s page-find API. The detached X11/CDP probe covers the shortcut and result navigation:

```bash
npm run test:find-in-page
```

`F11` toggles the native fullscreen window on Linux. The macOS-style `Ctrl+Cmd+F` chord is accepted as well; the detached X11/CDP probe verifies both transitions without opening the app on the user’s desktop:

```bash
npm run test:fullscreen
```

User downloads appear in the toolbar’s Downloads menu with progress, an Open action that uses the Linux desktop default application, and a Show action. Primary-tab downloads use `EGO_LITE_DOWNLOAD_DIR` when set, otherwise the normal `~/Downloads` directory; task-Space downloads retain the SDK/CDP-selected download path.

The History menu keeps the last 100 HTTP(S) visits for the active profile, excludes private tabs, opens entries in the active tab, and provides Clear history. Its persistence and toolbar behavior are covered by `npm run test:history` and the detached private-tab/download probe.

The native window restores its last usable position and size, keeps the normal bounds behind a maximized session, and restores maximized state on the next launch. The detached X11/Xvfb probe covers seed, resize, quit, and restart restoration:

```bash
npm run test:window-state
```

The Spaces menu lists active agent workspaces and exposes Take over/Return control plus Stop actions; stopping a Space closes its task tabs and removes its persisted task state.

The Electron toolbar also provides New tab and Close tab controls, with Ctrl/Cmd+T and Ctrl/Cmd+W shortcuts from either the toolbar or the focused page; closing the final primary tab keeps one blank replacement tab available.

When a Space is revealed, the toolbar’s live control badge reports whether the Space is under agent or user control; it follows the ownership state written by the SDK’s handoff and takeover methods.

Labeled pointer actions from the SDK update the local toolbar task status and briefly draw a pointer ring in the selected page. The DOM probe checks both effects without opening a foreground window:

```bash
npm run test:agent-visuals
```

The Electron task-space cookie inheritance probe runs under a disposable profile and verifies both login-state inheritance and per-Space cookie isolation:

```bash
npm run test:cookie-parity
```

The background-Space probe verifies that creating a task tab leaves the primary tab visible, that explicit reveal works, and that closing the task restores the primary tab:

```bash
npm run test:background-space
```

The profile-migration probe verifies explicit Chrome-data migration, backup creation, and cookie transfer:

```bash
npm run test:profile-migration
```

The password-migration probe verifies that basic plaintext data is eligible while keyring-backed and encrypted stores are excluded:

```bash
npm run test:password-migration
```

Migration also captures restorable HTTP(S) tabs and Chromium tab-group metadata through a temporary isolated MV3 probe. The Electron shell recreates those tabs in the primary browser picker, exposes an accessible Groups control for expanding/collapsing them, and persists each group's title, color, and collapsed state. Browser-internal pages and keyring-backed passwords remain excluded. The detached restoration and toolbar DOM probe is:

```bash
npm run test:migrated-tabs
```

The Electron shell also persists its primary tabs and active tab across a restart, while task-Space tabs remain owned by the agent state. The detached restart probe verifies the session manifest, restored URLs, active tab, and toolbar DOM:

```bash
npm run test:session-restore
```

Task-Space tabs are also persisted as background views and rebound to the current Electron targets when the app restarts. The detached probe verifies restored Space URLs, SDK reuse, the Spaces menu, ownership handoff, stopping a Space, and the toolbar DOM:

```bash
npm run test:space-restore
```

The detached Import data probe clicks the toolbar control through renderer CDP, verifies restart-safe profile migration and backup preservation, and checks the control after relaunch:

```bash
npm run test:import-data
```

The detached tab-control probe verifies button actions, toolbar keyboard shortcuts, active-tab fallback, and the toolbar DOM:

```bash
npm run test:tab-controls
```

Agent task tabs start muted so background work cannot interrupt user audio. The toolbar exposes a per-tab Mute/Unmute control; the detached audio probe verifies the default and toggle behavior through the bridge and renderer DOM:

```bash
npm run test:tab-audio
```

F12 toggles Developer Tools for the active BrowserView. The detached X11/CDP probe sends the native key and verifies the per-tab state without opening a foreground window:

```bash
npm run test:devtools
```

The detached profile probe verifies an explicit profile registry and the Profile toolbar menu without opening a foreground window:

```bash
npm run test:profiles
```

The detached CLI profile probe verifies that `ego-lite --cli --profile work --doctor` routes both browser data and task-Space state to the selected profile:

```bash
npm run test:profile-cli
```

The migration-discovery probe verifies that all usable supported profiles are enumerated while the standalone single-profile helper refuses to guess when multiple profiles are available:

```bash
npm run test:migration-discovery
```

The detached multi-profile onboarding probe verifies that first-run migration can select `Profile 1` explicitly without guessing or opening a foreground window:

```bash
npm run test:migration-prompt:multi
```

The detached onboarding probe verifies that the one-time decision marker is written before the browser bridge starts:

```bash
npm run test:migration-prompt
```

The Electron-specific variant verifies the packaged CLI path without opening a browser window:

```bash
npm run test:profile-migration:electron
```

Migrated unpacked Chrome-family extensions are loaded into the primary session and each isolated task Space when the Electron app starts. The Extensions menu lists them and persists enable/disable changes across the profile, including existing task Spaces. A bad extension is skipped without preventing the browser from launching. The bounded probe confirms service-worker loading, toolbar inventory, and disable/re-enable behavior:

```bash
npm run test:extension-loading
```

The snapshot-contract probe covers action marks, stable role locators, result limits, and viewport filtering:

```bash
npm run test:snapshot-contract
```

The packaged CLI exposes the same migration and diagnostic commands as the standalone host, for example `ego-lite --cli --profile work --doctor` or `ego-lite --cli --migrate-profile --from "$HOME/.config/google-chrome"`. Close the source browser first; only Chromium’s basic plaintext password store is imported.

Do not run the Electron package and the standalone Linux host against the same profile at the same time. Set `EGO_LITE_PROFILE_DIR` to use a separate profile.
