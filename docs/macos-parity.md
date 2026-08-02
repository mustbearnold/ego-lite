# macOS parity inventory

This is the working inventory for the Linux/Electron port. It records contracts
that can be observed from the upstream macOS product, rather than treating a
similar-looking toolbar as proof of parity.

## Evidence

- The public product documentation describes isolated Spaces, shared browser
  login state, background agent work, Snapshot, and the `ego-browser` runtime:
  <https://lite.ego.app/document/en/docs/space>.
- The current macOS download advertises HTTP, HTTPS, and local-file document
  handling in `Contents/Info.plist`, and its `scripting.sdef` enables AppleScript
  automation for windows, tabs, and bookmarks. The inspected bundle was version
  `0.4.5.5` on 2026-08-03:
  <https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg>.
- The repository's shared SDK and skill are the compatibility boundary; the
  macOS browser chrome and custom snapshot implementation are not open source.

## Contract matrix

| Observable macOS contract | Linux/Electron status | Evidence or remaining gap |
| --- | --- | --- |
| Human tabs remain separate from agent Spaces | Implemented | Task-space ownership, background views, handoff/takeover, cookie inheritance, and restart restoration are covered by detached probes. |
| Shared logged-in browser state with isolated agent storage | Implemented with Linux tab-scoped Spaces | Electron uses separate persistent task views and inherits a cookie snapshot; the standalone host uses Chromium contexts when available. |
| Snapshot and `ego-browser` automation | Implemented with a known engine difference | The helper surface and CDP contract are shared; Linux renders Chromium AX trees and walks nested frames instead of using the macOS custom snapshot engine. |
| Open HTTP/HTTPS URLs and local files from the desktop | Implemented in this parity slice | Linux desktop entries pass `%U`; Electron handles initial arguments, second instances, `open-file`, and `open-url`; standalone launches open one or more targets. |
| Window/tab properties exposed to automation | Implemented with a Linux contract | The authenticated bridge and `ego-lite --automation` CLI expose a versioned window, tab, Space, loading, group, audio, and devtools state model. Linux does not emulate AppleScript syntax. |
| Back, forward, reload, stop, save, print, view source, and execute JavaScript | Implemented for Linux/Electron | The toolbar, authenticated bridge, and native File/View menus share stop, HTML-complete save, print-dialog/PDF-test, and view-source actions. The detached page-action probe verifies DOM controls, native menu labels, saved output, PDF output, source content, and stopping a live load. |
| Bookmark folders and bookmark items are scriptable | Implemented with a Linux contract | Bookmark listing, add, remove, open, and toggle actions return stable item ids and folder paths through the authenticated bridge and CLI. |
| AppleScript application/window/tab/bookmark automation | Linux equivalent implemented | Linux exposes the same observable object/action boundary through authenticated HTTP bridge calls and a one-shot versioned JSON CLI; AppleScript itself remains macOS-only. |
| Migration, extensions, private tabs, downloads, history, reading list, sync, profiles, fullscreen, find, devtools, and updates | Implemented or intentionally Linux-specific | See `platform/electron/README.md` for the detached probe attached to each feature. |

## Next parity slices

1. Close remaining snapshot wording and interaction differences against a
   captured macOS contract corpus.

The matrix is deliberately maintained alongside implementation commits so a
passing Linux test cannot be mistaken for complete macOS parity.
