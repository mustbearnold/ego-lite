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

## Objects and properties

| macOS object | Observed properties and elements | Linux JSON status |
| --- | --- | --- |
| application | `name`, `frontmost`, `version`; windows; `open`, `print`, `quit` | Window/tab state is exposed through `state`, `window.get`, and `tabs.list`; application-level commands are not yet mapped one-for-one. |
| window | `given name`, `name`/title, `id`, `index`, `bounds`, `closeable`, `minimizable`, `minimized`, `resizable`, `visible`, `zoomable`, `zoomed`, `active tab`, `mode`, `active tab index`; tabs; `close` | Electron reports a useful window state and tab inventory. Standalone Chromium reports a synthetic window; the full macOS property set is not yet exposed. |
| tab | `id`, `title`, `URL`, `loading` | Exposed in `state` and `tabs.list`, with lifecycle, navigation, edit, save, print, source, and JavaScript actions. |
| bookmark folder | Nested folders and items; `id`, `title`, `index` | The Linux contract currently flattens bookmark items and does not expose folder CRUD or nested folder traversal. |
| bookmark item | `id`, `title`, `URL`, `index` | Stable item ids plus list/add/remove/open/toggle are exposed; parent-folder and index semantics remain incomplete. |

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

Electron delegates save to Chromium's page archive and print to Chromium's PDF
output. The standalone host supports HTML/DOM serialization and MHTML capture
through CDP, and writes a PDF directly; it does not reproduce the native macOS
print dialog or every asset-handling detail of a desktop page save.

## Standard-suite commands still to map

The dictionary also includes generic AppleScript commands such as `count`,
`delete`, `duplicate`, `exists`, `make`, and `move`, plus application-level
`open`, `print`, and `quit`. They are separate from the tab command slice and
remain tracked as future parity work.
