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

Agent-created task tabs stay in the background by default, so creating or navigating a Space does not replace the user’s visible tab. Use the toolbar’s tab picker to inspect or reveal a Space explicitly.

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
