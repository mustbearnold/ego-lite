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
port keeps the authenticated versioned JSON contract as its native transport
and now adds a portable `--applescript` adapter for a deliberately bounded
subset of the observed syntax. The adapter is useful for scripts that need to
move between hosts, but it is not native AppleScript and does not reproduce all
of macOS's implicit specifier coercion.

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
| application | `name`, `frontmost`, `version`; windows; `open`, `print`, `quit` | `state.application` and `application.get` expose the application properties; `application.open`, `application.print`, and `application.quit` are exposed through the versioned JSON bridge. Responses are typed Linux equivalents rather than AppleScript syntax. |
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
`standard.print`, `standard.count`, `standard.exists`, `standard.delete`,
`standard.duplicate`, `standard.make`, and `standard.move`. They accept a
`kind` such as `window`, `tab`, `space`, `bookmarkFolder`, or `bookmarkItem`.
Tab and standard-object selectors accept an `id`/`targetId`, `name`/`title`,
`url`, or a 1-based `index`; the same fields can be nested in a `specifier`
record (or passed as a string/number). Folder selectors additionally accept an
exact nested `path`, and folder destinations accept an id, title, path, or
record. Delete, duplicate, activate, and other tab actions resolve those
selectors instead of silently falling back to the active tab.
`standard.count` accepts `each`, `standard.make` accepts `new`, `withProperties`,
and `at`, and `standard.move` accepts `to` as aliases for the typed fields.
Tab moves accept `spaceId`, `destinationSpaceId`, or a Space name/task id for
the destination, plus `sourceSpaceId` when the source is outside the currently
selected standalone scope. Cross-Space moves keep the storage isolation
boundary: Electron restores Chromium's serialized navigation entries before
the destination first loads, while standalone CDP rebuilds a bounded URL
history and restores safe form/scroll state. Password/file controls, storage
areas, POST bodies, and non-serializable application state are intentionally
not copied. The response reports best-effort `preservation.history` and
`preservation.interaction` statuses. Native AppleScript syntax and its full
implicit specifier coercion are not reproduced; the portable subset is described
below.

Electron delegates save to Chromium's page archive and print to Chromium's PDF
output. The standalone host supports HTML/DOM serialization and MHTML capture
through CDP, and writes a PDF directly; it does not reproduce the native macOS
print dialog or every asset-handling detail of a desktop page save.

## Portable AppleScript-style adapter

Both the standalone host and the Electron packaged CLI accept one or more
bounded commands per invocation on standard input:

```bash
printf '%s\n' 'get URL of active tab' | ego-lite --applescript
printf '%s\n' 'count tabs' | ego-lite --cli --applescript
```

Commands inside a `tell application` block execute sequentially. The response
from the final command is returned, with `script.statements` reporting the
number of commands when the block contained more than one.

The adapter accepts the observed `tell application` wrapper for `ego lite`,
`Chromium`, and compatible ego-browser names. It translates application
properties and commands, window and tab specifiers, bookmark folders/items,
`get`, `count`, `exists`, `set URL`/window name, `open`, `print`, `save`,
`execute javascript`, tab editing/navigation commands, and the covered
standard-suite `delete`, `duplicate`, `make new`, and `move` forms. `get`,
`count`, and `exists` return their value under `result.value`; mutating commands
retain the typed automation result so callers can inspect the resulting state.

The adapter intentionally rejects unsupported application targets and forms it
cannot translate. Print and save use explicit `in file` paths (or the existing
typed environment overrides); native AppleScript execution, full coercion,
AppleScript records beyond the supported property forms, and the native macOS
print dialog remain outside this Linux boundary.
