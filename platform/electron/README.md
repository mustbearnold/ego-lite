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

The Electron task-space cookie inheritance probe runs under a disposable profile and verifies both login-state inheritance and per-Space cookie isolation:

```bash
npm run test:cookie-parity
```

Do not run the Electron package and the standalone Linux host against the same profile at the same time. Set `EGO_LITE_PROFILE_DIR` to use a separate profile.
