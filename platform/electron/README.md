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

On the first packaged-app launch, when exactly one supported Chromium-family profile is found and the ego lite profile is still empty, a one-time migration prompt offers to copy portable browser data before the browser window opens. Set `EGO_LITE_SKIP_MIGRATION=1` for unattended launches; choosing to keep profiles separate records the decision in the target profile. Saved passwords remain excluded from migration.

The toolbar’s Import button provides the repeatable Settings → Import data path. It opens a directory chooser for a Chromium-family user-data directory or profile, saves the request, restarts the app, performs the guarded migration before the new window opens, restores imported HTTP(S) tabs and groups, and backs up replaced target data. Close the source browser first; saved passwords remain excluded.

Agent-created task tabs stay in the background by default, so creating or navigating a Space does not replace the user’s visible tab. Use the toolbar’s tab picker to inspect or reveal a Space explicitly.

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

Migration also captures restorable HTTP(S) tabs and Chromium tab-group metadata through a temporary isolated MV3 probe. The Electron shell recreates those tabs in the primary browser picker and retains each group's title, color, and collapsed marker. Browser-internal pages and encrypted passwords remain excluded. The detached restoration and toolbar DOM probe is:

```bash
npm run test:migrated-tabs
```

The Electron shell also persists its primary tabs and active tab across a restart, while task-Space tabs remain owned by the agent state. The detached restart probe verifies the session manifest, restored URLs, active tab, and toolbar DOM:

```bash
npm run test:session-restore
```

The detached Import data probe clicks the toolbar control through renderer CDP, verifies restart-safe profile migration and backup preservation, and checks the control after relaunch:

```bash
npm run test:import-data
```

The migration-discovery probe verifies that onboarding selects only one usable supported profile and refuses to guess when multiple profiles are available:

```bash
npm run test:migration-discovery
```

The detached onboarding probe verifies that the one-time decision marker is written before the browser bridge starts:

```bash
npm run test:migration-prompt
```

The Electron-specific variant verifies the packaged CLI path without opening a browser window:

```bash
npm run test:profile-migration:electron
```

Migrated unpacked Chrome-family extensions are loaded into the primary session and each isolated task Space when the Electron app starts. A bad extension is skipped without preventing the browser from launching. The bounded probe confirms that a migrated Manifest V3 extension starts as an extension service worker:

```bash
npm run test:extension-loading
```

The snapshot-contract probe covers action marks, stable role locators, result limits, and viewport filtering:

```bash
npm run test:snapshot-contract
```

The packaged CLI exposes the same migration command as the standalone host, for example `ego-lite --cli --migrate-profile --from "$HOME/.config/google-chrome"`. Close the source browser first; passwords are intentionally not imported.

Do not run the Electron package and the standalone Linux host against the same profile at the same time. Set `EGO_LITE_PROFILE_DIR` to use a separate profile.
