# Observed macOS scripting contract

This document records the macOS automation surface inspected for the parity
project. It is evidence for the Linux implementation, not a claim that the
closed-source macOS app exposes a stable API beyond the inspected build.

## Inspection source

- Download URL: <https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg>
- Observed bundle version: `0.4.5.5` (`CFBundleVersion=4.5.5`)
- Observed on: 2026-08-03
- DMG SHA-256: `5be7a66610f1b966c7547262c3c7f99880ca9503628031d09426e00d6803ebd8`
- Bundle identifier: `com.citrolabs.ego.lite`
- AppleScript metadata: `NSAppleScriptEnabled=true`,
  `OSAScriptingDefinition=scripting.sdef`

The bundle's `scripting.sdef` defines an AppleScript object model consisting of
an application, windows, tabs, bookmark folders, and bookmark items. The Linux
port uses authenticated versioned JSON because AppleScript is not available on
Linux; the JSON actions below are the transport-level equivalent, not an
attempt to emulate AppleScript syntax or specifier resolution.

The JSON response keeps the original flat `bookmarks` array for existing
clients and adds `bookmarkItems` plus nested `bookmarkFolders`. Linux keeps an
ego-owned bookmark document alongside Chromium's profile file so mutations
survive Chromium shutdown and restart. Window state keeps the existing `title`
field and adds the macOS-shaped property names; the Electron-only window
commands are `window.set-name`, `window.minimize`, `window.restore`,
`window.maximize`, and `window.unmaximize`.

## Objects and properties

| macOS object | Observed properties and elements | Linux JSON status |
| --- | --- | --- |
| application | `name`, `frontmost`, `version`; windows; `open`, `print`, `quit` | `application.open`, `application.print`, and `application.quit` are exposed through the versioned JSON bridge; responses are typed Linux equivalents rather than AppleScript syntax. |
| window | `given name`, `name`/title, `id`, `index`, `bounds`, `closeable`, `minimizable`, `minimized`, `resizable`, `visible`, `zoomable`, `zoomed`, `active tab`, `mode`, `active tab index`; tabs; `close` | Electron reports the complete listed property set through the JSON window object and supports naming/minimize/restore/maximize controls. Standalone Chromium reports a synthetic window and uses `null` for native-window capability fields. |
| tab | `id`, `title`, `URL`, `loading` | Exposed in `state` and `tabs.list`, with lifecycle, navigation, edit, save, print, source, and JavaScript actions. |
| bookmark folder | Nested folders and items; `id`, `title`, `index` | `bookmarkFolders` preserves nested folders and exposes folder add/rename/remove/move/reorder/duplicate actions in both runtimes. |
| bookmark item | `id`, `title`, `URL`, `index` | `bookmarkItems` exposes stable ids, titles, URLs, parent folder ids, and child indices; list/add/remove/open/toggle/move/reorder/duplicate are exposed. |

## Tab commands

The inspected tab class responds to the following commands:

| macOS command | Linux JSON action |
| --- | --- |
| `undo` | `tab.undo` |
| `redo` | `tab.redo` |
| `cut selection` | `tab.cut` |
| `copy selection` | `tab.copy` |
| `paste selection` | `tab.paste` |
| `select all` | `tab.select-all` |
| `go back` / `go forward` | `tab.back` / `tab.forward` |
| `reload` / `stop` | `tab.reload` / `tab.stop` |
| `execute` with `javascript` | `tab.execute` with `params.javascript` |
| `save` | `tab.save` with `params.path` and optional `params.as` |
| `print` | `tab.print` with `params.path` |
| `view source` | `tab.view-source` |
| `close` | `tab.close` |

Bookmark folder mutations use `bookmark.folder.add`,
`bookmark.folder.rename`, and `bookmark.folder.remove`; item mutations accept
`parentId`/`folderId` for nested insertion and remove by exact item id when
provided. `bookmark.move` and `bookmark.reorder` accept a destination folder
and a 1-based `index`; `standard.move` is the generic command equivalent.

## Standard-suite command equivalents

The generic AppleScript commands are available through typed JSON actions:
`standard.count`, `standard.exists`, `standard.delete`,
`standard.duplicate`, `standard.make`, and `standard.move`. They accept a
`kind` such as `window`, `tab`, `space`, `bookmarkFolder`, or `bookmarkItem`.
Tab and standard-object selectors accept an `id`/`targetId`, `name`/`title`,
`url`, or a 1-based `index`; delete, duplicate, activate, and other tab actions
resolve those selectors instead of silently falling back to the active tab.
`standard.move` accepts `spaceId`, `destinationSpaceId`, or a Space name/task id
for tab moves, and `sourceSpaceId` when the source is outside the currently
selected standalone scope. Cross-Space moves recreate the destination view from
the tab URL so the isolation boundary remains intact; transient page state and
history are not promised to survive. AppleScript syntax and its full implicit
specifier coercion are not reproduced.

Electron delegates save to Chromium's page archive and print to Chromium's PDF
output. The standalone host supports HTML/DOM serialization and MHTML capture
through CDP, and writes a PDF directly; it does not reproduce the native macOS
print dialog or every asset-handling detail of a desktop page save.
