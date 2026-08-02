# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on an ego-compatible browser host. On macOS, the `ego-browser` command is provided by the ego lite app. On Linux, this checkout provides an open-source host that launches Chromium and bridges the same SDK through CDP.

ego lite website: https://lite.ego.app/

## Install steps (macOS)

The install script lives at `scripts/install.sh` in this skill. On macOS it will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

## Install steps (Linux)

Linux requires Node.js 22+, Chromium or Google Chrome, and this repository checkout. The Linux host is intentionally user-local; it does not need root or a system package install.

From the repository root, run:

```bash
sh skills/ego-browser/scripts/install.sh
```

The installer builds the SDK, installs the host and skill under `~/.local/share/ego-lite`, adds `ego-browser` and `ego-lite` to `~/.local/bin`, and creates a desktop entry under `~/.local/share/applications`. Keep `~/.local/bin` on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
ego-browser --doctor
```

The browser profile is stored under `~/.local/share/ego-lite/chromium-profile`; task-space metadata is stored under `~/.local/state/ego-lite/task-spaces.json`. Set `EGO_LITE_HEADLESS=1` for CI or machines without a display. Set `EGO_BROWSER_EXECUTABLE` when Chromium is installed at a non-standard path.

The Linux host uses Chromium's standard accessibility tree for semantic snapshots. It preserves the existing SDK, task-space ownership, browser permission CDP, screenshots, downloads, uploads, and locator behavior, but it cannot reproduce the closed-source macOS app's custom snapshot engine or automatic Chrome-profile migration.

For a self-contained Electron package with embedded Chromium, run `npm install` and `npm run package:appimage` from `platform/electron`. The AppImage includes the Linux host, SDK, and skill resources; launch it normally for the desktop browser or pass `--cli` for the bundled `ego-browser` command path.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpaces.useOrCreate(name)` and proceed as usual.

## Troubleshooting

- **Chromium not found on Linux**: install Chromium/Chrome or set `EGO_BROWSER_EXECUTABLE=/absolute/path/to/chromium`, then rerun the installer.
- **No graphical session on Linux**: set `EGO_LITE_HEADLESS=1` before running `ego-browser`.
- **Linux build fails**: confirm Node.js 22+ is active and run `cd package/ego-browser && npm ci && npm run build` from the checkout.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.
