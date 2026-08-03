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
  `0.4.5.5` on 2026-08-03; the extracted dictionary and SHA-256 are recorded in
  [`macos-scripting-contract.md`](macos-scripting-contract.md):
  <https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg>.
- The repository's shared SDK and skill are the compatibility boundary; the
  macOS browser chrome and custom snapshot implementation are not open source.

## Contract matrix

| Observable macOS contract | Linux/Electron status | Evidence or remaining gap |
| --- | --- | --- |
| Human tabs remain separate from agent Spaces | Implemented | Task-space ownership, background views, handoff/takeover, cookie inheritance, and restart restoration are covered by detached probes. |
| Shared logged-in browser state with isolated agent storage | Implemented with Linux tab-scoped Spaces | Electron uses separate persistent task views and inherits a cookie snapshot; the standalone host uses Chromium contexts when available. |
| Snapshot and `ego-browser` automation | Implemented with a known engine difference | The helper surface and CDP contract are shared; Linux renders Chromium AX trees, emits stable role/href locators plus link URLs, and walks nested frames instead of using the macOS custom snapshot engine. |
| Open HTTP/HTTPS URLs and local files from the desktop | Implemented in this parity slice | Linux desktop entries pass `%U`; Electron handles initial arguments, second instances, `open-file`, and `open-url`; standalone launches open one or more targets. |
| Window/tab properties exposed to automation | Implemented with standalone limits | Electron now reports the macOS-shaped window name/given name, index, bounds, close/minimize/resize/zoom capability flags, minimized/zoomed/visible state, active tab/index, mode, and the existing tab model. Standalone Chromium reports the same fields where meaningful and `null` for native-window capabilities. Native AppleScript syntax and full specifier coercion remain gaps. |
| Back, forward, reload, stop, save, print, view source, and execute JavaScript | Implemented with output differences | The authenticated bridge and CLI now cover navigation, editing, JavaScript execution, save, print-to-PDF, and view-source actions; typed `standard.print` now targets tabs or windows in both hosts. Electron delegates page saves to Chromium; standalone CDP saves serialize HTML or capture MHTML. Native macOS print-dialog behavior and all save-format details are not identical. |
| Bookmark folders and bookmark items are scriptable | Implemented with command gaps | `bookmarks.list` now preserves nested folder trees, folder ids/titles/indices, item parent folders, item titles/URLs/indices, and the legacy flat list. Folder add/rename/remove, exact-id mutations, move/reorder, and duplicate work in both runtimes; an ego-owned bookmark store survives Chromium profile shutdown. Native AppleScript syntax and coercion remain platform-specific. |
| AppleScript application/window/tab/bookmark automation | Implemented as a portable AppleScript-style subset over the typed contract | Linux exposes `--applescript` for bounded command blocks, including `tell application` blocks, application/window/tab/bookmark specifiers, `get`, `count`, `exists`, `set`, `open`, `print`, `save`, `execute`, and the covered standard-suite mutations. `every` collection properties, `first`/`last` ordinals, and parent-scoped reads/counts are covered in both hosts. Commands execute sequentially through the same authenticated bridge or standalone CDP dispatcher; multi-command responses report `script.statements`. Native AppleScript parsing, full implicit coercion, and native macOS print-dialog semantics remain platform-specific. |
| Migration, extensions, private tabs, downloads, history, reading list, sync, profiles, fullscreen, find, devtools, and updates | Implemented or intentionally Linux-specific | See `platform/electron/README.md` for the detached probe attached to each feature. |

## Next parity slices

1. Close remaining snapshot wording and interaction differences against a
   captured macOS contract corpus.
2. Close the remaining native AppleScript syntax/coercion, native print, and
   custom-snapshot differences; macOS runtime behavior still needs a runnable
   build for a direct comparison beyond the inspected scripting dictionary.

The matrix is deliberately maintained alongside implementation commits so a
passing Linux test cannot be mistaken for complete macOS parity.
