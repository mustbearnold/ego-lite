import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUTOMATION_VERSION = 1;

const APPLICATION_NAMES = new Set([
  "chromium",
  "ego browser",
  "ego lite",
  "ego-browser",
  "ego-lite",
  "google chrome",
]);

const COLLECTION_KINDS = new Map([
  ["window", "windows"],
  ["windows", "windows"],
  ["tab", "tabs"],
  ["tabs", "tabs"],
  ["bookmark", "bookmarkItems"],
  ["bookmarks", "bookmarkItems"],
  ["bookmark item", "bookmarkItems"],
  ["bookmark items", "bookmarkItems"],
  ["item", "bookmarkItems"],
  ["items", "bookmarkItems"],
  ["bookmark folder", "bookmarkFolders"],
  ["bookmark folders", "bookmarkFolders"],
  ["folder", "bookmarkFolders"],
  ["folders", "bookmarkFolders"],
  ["space", "spaces"],
  ["spaces", "spaces"],
]);

const PROPERTY_ALIASES = new Map([
  ["name", "name"],
  ["given name", "givenName"],
  ["title", "title"],
  ["frontmost", "frontmost"],
  ["version", "version"],
  ["id", "id"],
  ["index", "index"],
  ["bounds", "bounds"],
  ["closeable", "closeable"],
  ["minimizable", "minimizable"],
  ["minimized", "minimized"],
  ["resizable", "resizable"],
  ["visible", "visible"],
  ["zoomable", "zoomable"],
  ["zoomed", "zoomed"],
  ["active", "active"],
  ["active tab", "activeTab"],
  ["mode", "mode"],
  ["active tab index", "activeTabIndex"],
  ["url", "url"],
  ["loading", "loading"],
]);

const TAB_COMMANDS = [
  ["go back", "tab.back"],
  ["back", "tab.back"],
  ["go forward", "tab.forward"],
  ["forward", "tab.forward"],
  ["reload", "tab.reload"],
  ["stop", "tab.stop"],
  ["undo", "tab.undo"],
  ["redo", "tab.redo"],
  ["cut selection", "tab.cut"],
  ["cut", "tab.cut"],
  ["copy selection", "tab.copy"],
  ["copy", "tab.copy"],
  ["paste", "tab.paste"],
  ["select all", "tab.select-all"],
  ["view source", "tab.view-source"],
  ["close", "tab.close"],
];

export function appleScriptFailure(code, message, details = undefined) {
  return {
    version: AUTOMATION_VERSION,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function parseAppleScript(source) {
  if (typeof source !== "string" || !source.trim()) {
    return appleScriptFailure(
      "EGO_APPLESCRIPT_INVALID_SOURCE",
      "AppleScript input must be a non-empty string",
    );
  }

  let normalized;
  try {
    normalized = normalizeScript(source);
  } catch (error) {
    return appleScriptFailure(
      error?.code || "EGO_APPLESCRIPT_INVALID_SOURCE",
      error?.message || String(error),
    );
  }
  if (normalized.ok === false) return normalized;

  try {
    const parsed = normalized.statements.map((statement, index) => {
      try {
        return parseStatement(statement);
      } catch (error) {
        error.details = {
          ...(error.details || {}),
          statementIndex: index,
        };
        throw error;
      }
    });
    if (parsed.length === 1) return { ok: true, ...parsed[0] };
    return {
      ok: true,
      statements: parsed,
      statementCount: parsed.length,
    };
  } catch (error) {
    return appleScriptFailure(
      error?.code || "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      error?.message || String(error),
      error?.details,
    );
  }
}

export function projectAppleScriptResponse(response, projection) {
  if (!response || response.ok !== true || !projection) return response;

  if (projection.type === "count") {
    return {
      ...response,
      result: { value: response.result?.count ?? 0 },
    };
  }
  if (projection.type === "exists") {
    return {
      ...response,
      result: { value: Boolean(response.result?.exists) },
    };
  }
  if (projection.type === "get") {
    const state = response.result?.state || response.result || {};
    return {
      ...response,
      result: { value: projectGetValue(state, projection) },
    };
  }
  return response;
}

function normalizeScript(source) {
  const stripped = stripComments(source).replace(/¬/g, " ");
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return appleScriptFailure(
      "EGO_APPLESCRIPT_INVALID_SOURCE",
      "AppleScript input contains no command",
    );
  }

  let body = lines.join("\n");
  const first = lines[0].match(/^tell\s+application\s+(.+)$/i);
  if (first) {
    const appName = parseLiteral(first[1]);
    assertSupportedApplication(appName);
    if (!/^end\s+tell$/i.test(lines.at(-1) || "")) {
      throwAppleScript(
        "EGO_APPLESCRIPT_INVALID_SOURCE",
        "tell application blocks must end with end tell",
      );
    }
    body = lines.slice(1, -1).join("\n");
  } else {
    const inline = stripped.trim().match(
      /^tell\s+application\s+(.+?)\s+to\s+(.+)$/i,
    );
    if (inline) {
      assertSupportedApplication(parseLiteral(inline[1]));
      body = inline[2];
    } else if (lines.some((line) => /^end\s+tell$/i.test(line))) {
      throwAppleScript(
        "EGO_APPLESCRIPT_INVALID_SOURCE",
        "end tell must close a tell application block",
      );
    }
  }

  const statements = splitStatements(body).map(compactWhitespace).filter(Boolean);
  if (statements.length === 0) {
    return appleScriptFailure(
      "EGO_APPLESCRIPT_INVALID_SOURCE",
      "tell application block contains no command",
    );
  }
  return { ok: true, statements };
}

function parseStatement(statement) {
  const lower = statement.toLowerCase();
  if (/^get\b/i.test(statement)) return parseGet(statement.slice(3).trim());
  if (/^count\b/i.test(statement)) {
    return parseCount(statement.slice(5).trim());
  }
  if (/^exists\b/i.test(statement)) {
    return parseExists(statement.slice(6).trim());
  }
  if (/^set\b/i.test(statement)) return parseSet(statement.slice(3).trim());
  if (/^open\b/i.test(statement)) return parseOpen(statement.slice(4).trim());
  if (/^print\b/i.test(statement)) {
    return parsePrint(statement.slice(5).trim());
  }
  if (/^save\b/i.test(statement)) return parseSave(statement.slice(4).trim());
  if (/^execute\b/i.test(statement)) {
    return parseExecute(statement.slice(7).trim());
  }
  if (/^quit\b/i.test(statement)) {
    return { request: request("application.quit") };
  }
  if (/^delete\b/i.test(statement)) {
    return parseStandardMutation("standard.delete", statement.slice(6).trim());
  }
  if (/^duplicate\b/i.test(statement)) {
    return parseStandardMutation("standard.duplicate", statement.slice(9).trim());
  }
  if (/^make\s+new\b/i.test(statement)) {
    return parseMake(statement.replace(/^make\s+new\s+/i, ""));
  }
  if (/^move\b/i.test(statement)) {
    return parseMove(statement.slice(4).trim());
  }

  for (const [command, action] of TAB_COMMANDS) {
    if (lower === command || lower.startsWith(`${command} `)) {
      const targetText = statement.slice(command.length).trim();
      const target = targetText ? parseSpecifier(targetText) : activeTabSpecifier();
      if (target.kind !== "tabs") {
        throwAppleScript(
          "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
          `${command} only supports tab objects in the Linux adapter`,
        );
      }
      return { request: request(action, tabActionParams(target)) };
    }
  }

  throwAppleScript(
    "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
    `unsupported AppleScript command: ${statement}`,
  );
}

function parseGet(expression) {
  const direct = tryParseSpecifier(expression);
  if (direct) {
    return {
      request: request(direct.kind === "application" ? "application.get" : "state"),
      projection: {
        type: "get",
        kind: direct.kind,
        selector: direct,
        parent: direct.parent,
        property: null,
      },
    };
  }

  const split = splitFirstPhrase(expression, " of ");
  if (split) {
    const left = canonicalProperty(split.before);
    const collection = collectionKind(split.before);
    if (!left && !collection) {
      throwAppleScript(
        "EGO_APPLESCRIPT_UNSUPPORTED_PROPERTY",
        `unsupported AppleScript property: ${split.before}`,
      );
    }
    const parent = parseSpecifier(split.after);
    if (collection) {
      return {
        request: request("state"),
        projection: {
          type: "get",
          kind: collection,
          selector: { kind: collection, collection: true },
          parent,
          property: null,
        },
      };
    }
    return {
      request: request("state"),
      projection: {
        type: "get",
        kind: parent.kind,
        selector: parent,
        property: left,
      },
    };
  }

  const property = canonicalProperty(expression);
  if (property) {
    return {
      request: request("application.get"),
      projection: {
        type: "get",
        kind: "application",
        selector: { kind: "application" },
        property,
      },
    };
  }
  throwAppleScript(
    "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
    `cannot resolve get expression: ${expression}`,
  );
}

function parseCount(expression) {
  const target = parseSpecifier(expression.replace(/^of\s+/i, ""));
  const kind = target.kind === "application" ? "windows" : target.kind;
  return {
    request: request("standard.count", { kind }),
    projection: { type: "count", kind },
  };
}

function parseExists(expression) {
  const target = parseSpecifier(expression);
  if (target.kind === "application") {
    return {
      request: request("state"),
      projection: {
        type: "exists",
        application: true,
      },
    };
  }
  const kind = target.kind;
  return {
    request: request("standard.exists", standardActionParams(target)),
    projection: { type: "exists", kind },
  };
}

function parseSet(expression) {
  const split = splitFirstPhrase(expression, " to ");
  if (!split) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "set requires a target and a to value",
    );
  }
  const left = splitFirstPhrase(split.before, " of ");
  if (!left) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "set requires an object property such as URL of tab 1",
    );
  }
  const property = canonicalProperty(left.before);
  const target = parseSpecifier(left.after);
  const value = parseLiteral(split.after);
  if (property === "url" && target.kind === "tabs") {
    return {
      request: request("tab.navigate", {
        ...tabActionParams(target),
        url: normalizeOpenTarget(value),
      }),
    };
  }
  if (
    property === "name" ||
    property === "givenName" ||
    (property === "title" && target.kind === "windows")
  ) {
    if (target.kind !== "windows") {
      throwAppleScript(
        "EGO_APPLESCRIPT_UNSUPPORTED_PROPERTY",
        "window naming requires a window object",
      );
    }
    return { request: request("window.set-name", { name: String(value) }) };
  }
  throwAppleScript(
    "EGO_APPLESCRIPT_UNSUPPORTED_PROPERTY",
    `cannot set ${left.before} on ${left.after}`,
  );
}

function parseOpen(expression) {
  let body = expression.trim();
  body = body.replace(/^location\s+/i, "");
  const fileMatch = body.match(/^(?:posix\s+)?file\s+(.+)$/i);
  let value;
  if (fileMatch) {
    value = parseLiteral(fileMatch[1]);
    value = pathToFileURL(resolve(String(value))).toString();
  } else {
    value = parseLiteral(body);
    value = normalizeOpenTarget(value);
  }
  return { request: request("application.open", { url: value }) };
}

function parsePrint(expression) {
  const file = extractFileArgument(expression);
  if (!file) {
    throwAppleScript(
      "EGO_APPLESCRIPT_PRINT_PATH_REQUIRED",
      "print requires `in file \"/absolute/path.pdf\"` for the Linux adapter",
    );
  }
  const targetText = file.before.trim();
  const target = targetText ? parseSpecifier(targetText) : activeTabSpecifier();
  if (target.kind === "windows") {
    return {
      request: request("standard.print", {
        ...standardActionParams(target),
        path: file.path,
      }),
    };
  }
  if (target.kind !== "tabs") {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      "print only supports windows and tabs in the Linux adapter",
    );
  }
  return {
    request: request("tab.print", {
      ...tabActionParams(target),
      path: file.path,
    }),
  };
}

function parseSave(expression) {
  const file = extractFileArgument(expression);
  if (!file) {
    throwAppleScript(
      "EGO_APPLESCRIPT_SAVE_PATH_REQUIRED",
      "save requires `in file \"/absolute/path\"` for the Linux adapter",
    );
  }
  const target = file.before.trim()
    ? parseSpecifier(file.before.trim())
    : activeTabSpecifier();
  if (target.kind !== "tabs") {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      "save only supports tab objects in the Linux adapter",
    );
  }
  return {
    request: request("tab.save", {
      ...tabActionParams(target),
      path: file.path,
      ...(file.as ? { as: file.as } : {}),
    }),
  };
}

function parseExecute(expression) {
  const javascriptIndex = findWordOutsideQuotes(expression, "javascript");
  if (javascriptIndex < 0) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "execute requires a javascript string",
    );
  }
  const before = expression.slice(0, javascriptIndex).trim();
  const after = expression.slice(javascriptIndex + "javascript".length).trim();
  const literal = consumeLiteral(after);
  if (!literal) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "execute requires a quoted javascript string",
    );
  }
  let targetText = before;
  const suffix = literal.rest.trim();
  if (!targetText && /^of\s+/i.test(suffix)) {
    targetText = suffix.replace(/^of\s+/i, "");
  } else if (targetText && suffix) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "execute accepts one tab target and one javascript string",
    );
  }
  const target = targetText ? parseSpecifier(targetText) : activeTabSpecifier();
  if (target.kind !== "tabs") {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      "execute only supports tab objects in the Linux adapter",
    );
  }
  return {
    request: request("tab.execute", {
      ...tabActionParams(target),
      javascript: literal.value,
    }),
  };
}

function parseStandardMutation(action, expression) {
  const target = parseSpecifier(expression);
  if (!["tabs", "windows", "bookmarkItems", "bookmarkFolders"].includes(target.kind)) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      `${action} does not support ${target.kind}`,
    );
  }
  if (action === "standard.delete" && target.kind === "windows") {
    return { request: request(action, standardActionParams(target)) };
  }
  return { request: request(action, standardActionParams(target)) };
}

function parseMake(expression) {
  let rest = expression.trim();
  let properties = {};
  const propertyPosition = findPhraseOutsideQuotes(rest, " with properties ");
  if (propertyPosition >= 0) {
    properties = parseRecord(rest.slice(propertyPosition + " with properties ".length));
    rest = rest.slice(0, propertyPosition).trim();
  }
  let at = null;
  const atPosition = findPhraseOutsideQuotes(rest, " at ");
  if (atPosition >= 0) {
    at = parseSpecifier(rest.slice(atPosition + " at ".length));
    rest = rest.slice(0, atPosition).trim();
  }

  const kindMatch = rest.match(
    /^(bookmark\s+folder|bookmark\s+item|folder|item|tab|window|space)s?$/i,
  );
  if (!kindMatch) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      `unsupported make new object: ${rest}`,
    );
  }
  const kind = collectionKind(kindMatch[1]);
  if (kind === "tabs") {
    const params = {
      kind,
      ...(properties.url || properties.URL
        ? { url: normalizeOpenTarget(properties.url ?? properties.URL) }
        : {}),
    };
    if (at?.kind === "spaces") params.spaceId = spaceSelector(at);
    return { request: request("standard.make", params) };
  }
  if (kind === "bookmarkFolders") {
    return {
      request: request("standard.make", {
        kind,
        name: properties.name ?? properties.title,
        at: bookmarkDestination(at),
      }),
    };
  }
  if (kind === "bookmarkItems") {
    return {
      request: request("standard.make", {
        kind,
        name: properties.name ?? properties.title,
        url: normalizeOpenTarget(properties.url ?? properties.URL ?? ""),
        at: bookmarkDestination(at),
      }),
    };
  }
  throwAppleScript(
    "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
    `standard.make does not support ${kind}`,
  );
}

function parseMove(expression) {
  const split = splitFirstPhrase(expression, " to ");
  if (!split) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "move requires a source object and a destination",
    );
  }
  const source = parseSpecifier(split.before);
  const destination = parseSpecifier(split.after);
  if (source.kind === "tabs") {
    const to =
      destination.kind === "windows" || destination.kind === "application"
        ? "primary"
        : destination.kind === "spaces"
          ? { specifier: selectorWithoutKind(destination) }
          : null;
    if (to === null) {
      throwAppleScript(
        "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
        "tab moves target a window or Agent Space",
      );
    }
    return {
      request: request("standard.move", {
        ...standardActionParams(source),
        to,
      }),
    };
  }
  if (source.kind === "bookmarkItems" || source.kind === "bookmarkFolders") {
    if (destination.kind !== "bookmarkFolders") {
      throwAppleScript(
        "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
        "bookmark moves require a bookmark folder destination",
      );
    }
    return {
      request: request("standard.move", {
        ...standardActionParams(source),
        to: { specifier: selectorWithoutKind(destination) },
      }),
    };
  }
  throwAppleScript(
    "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
    `move does not support ${source.kind}`,
  );
}

function parseSpecifier(input) {
  let text = compactWhitespace(String(input || "").trim());
  text = text.replace(/^(?:the|a|an|every|all)\s+/i, "");
  if (!text) throwAppleScript("EGO_APPLESCRIPT_UNSUPPORTED_OBJECT", "empty object specifier");

  let parent = null;
  const parentPosition = findPhraseOutsideQuotes(text, " of ");
  if (parentPosition >= 0) {
    parent = parseSpecifier(text.slice(parentPosition + " of ".length));
    text = text.slice(0, parentPosition).trim();
  }

  const lower = text.toLowerCase();
  if (lower === "application" || lower === "front application") {
    return { kind: "application" };
  }
  if (lower === "front window" || lower === "frontmost window") {
    return { kind: "windows", index: 1 };
  }
  if (lower === "active tab" || lower === "current tab") {
    return withParent({ kind: "tabs", active: true }, parent);
  }

  const collection = collectionKind(text);
  if (collection && isCollectionPhrase(text)) {
    return withParent({ kind: collection, collection: true }, parent);
  }

  const kindMatch = text.match(
    /^(bookmark\s+folder|bookmark\s+item|folder|item|tab|window|space)s?\b\s*(.*)$/i,
  );
  if (!kindMatch) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_OBJECT",
      `unsupported object specifier: ${input}`,
    );
  }
  const kind = collectionKind(kindMatch[1]);
  const selectorText = kindMatch[2].trim();
  if (!selectorText) {
    if (kind === "tabs") return withParent({ kind, active: true }, parent);
    return withParent({ kind, index: 1 }, parent);
  }
  const selector = parseSelector(kind, selectorText);
  return withParent({ kind, ...selector }, parent);
}

function parseSelector(kind, text) {
  const whose = text.match(/^whose\s+(.+?)\s+is\s+(.+)$/i);
  if (whose) {
    const field = whose[1].trim().toLowerCase();
    const value = parseLiteral(whose[2]);
    if (["name", "title", "given name"].includes(field)) {
      return { name: String(value) };
    }
    if (["url", "u r l"].includes(field)) return { url: String(value) };
    if (field === "id") return { id: String(value) };
    if (field === "index") return { index: Number(value) };
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_PROPERTY",
      `unsupported whose property: ${whose[1]}`,
    );
  }
  if (/^first$/i.test(text)) return { index: 1 };
  if (/^last$/i.test(text)) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "last-object specifiers are not supported by the Linux adapter",
    );
  }
  const literal = parseLiteral(text);
  if (typeof literal === "number") return { index: literal };
  if (kind === "bookmarkFolders") return { path: String(literal) };
  if (kind === "spaces") return { name: String(literal) };
  return { name: String(literal) };
}

function withParent(selector, parent) {
  if (!parent) return selector;
  const result = { ...selector, parent };
  if (result.kind === "bookmarkItems" && parent.kind === "bookmarkFolders") {
    const parentSelector = selectorWithoutKind(parent);
    if (parentSelector.path !== undefined) result.folder = parentSelector.path;
    else if (parentSelector.name !== undefined) result.folder = parentSelector.name;
    else if (parentSelector.id !== undefined) result.folderId = parentSelector.id;
  }
  return result;
}

function activeTabSpecifier() {
  return { kind: "tabs", active: true };
}

function tabActionParams(selector) {
  return selector.active ? { active: true } : selectorWithoutKind(selector);
}

function standardActionParams(selector) {
  return {
    kind: selector.kind,
    ...(selector.active ? { active: true } : {}),
    ...selectorWithoutKind(selector),
  };
}

function selectorWithoutKind(selector) {
  const { kind: _kind, collection: _collection, active: _active, parent: _parent, ...fields } = selector;
  return fields;
}

function spaceSelector(selector) {
  if (selector.id !== undefined) return selector.id;
  if (selector.name !== undefined) return selector.name;
  return selector.title;
}

function bookmarkDestination(selector) {
  if (!selector) return "1";
  return { specifier: selectorWithoutKind(selector) };
}

function collectionKind(value) {
  return COLLECTION_KINDS.get(compactWhitespace(String(value || "").toLowerCase())) || null;
}

function isCollectionPhrase(value) {
  const text = compactWhitespace(String(value || "").toLowerCase());
  return text.startsWith("every ") ||
    text.startsWith("all ") ||
    ["windows", "tabs", "bookmarks", "bookmark items", "bookmark folders", "folders", "items", "spaces"].includes(text);
}

function canonicalProperty(value) {
  const key = compactWhitespace(String(value || "").toLowerCase());
  return PROPERTY_ALIASES.get(key) || null;
}

function tryParseSpecifier(value) {
  try {
    return parseSpecifier(value);
  } catch {
    return null;
  }
}

function request(action, params = {}) {
  return { version: AUTOMATION_VERSION, action, params };
}

function projectGetValue(state, projection) {
  if (projection.application) return true;
  const sourceState = state.state || state;
  if (projection.kind === "application") {
    return readProperty(sourceState.application || {}, projection.property);
  }
  const collection = valuesForKind(sourceState, projection.kind);
  if (projection.selector?.collection) {
    let values = collection;
    if (projection.parent?.kind === "bookmarkFolders") {
      const folder = selectValue(sourceState, projection.parent);
      if (folder) {
        values = values.filter(
          (item) =>
            item.folder === folder.path ||
            String(item.folderId || item.parentId || "") === String(folder.id),
        );
      }
    }
    return values;
  }
  const value =
    projection.selector?.active && projection.kind === "tabs"
      ? sourceState.tabs?.find((tab) => tab.active) || sourceState.window?.activeTab
      : selectValue(sourceState, projection.selector);
  if (projection.property === null || projection.property === undefined) return value ?? null;
  return readProperty(value || {}, projection.property);
}

function valuesForKind(state, kind) {
  if (kind === "windows") return state.window ? [state.window] : [];
  if (kind === "tabs") return state.tabs || [];
  if (kind === "bookmarkItems") return state.bookmarkItems || [];
  if (kind === "bookmarkFolders") return flattenFolders(state.bookmarkFolders);
  if (kind === "spaces") return state.taskSpaces || [];
  return [];
}

function flattenFolders(folders, result = []) {
  for (const folder of folders || []) {
    result.push(folder);
    flattenFolders(folder.folders, result);
  }
  return result;
}

function selectValue(state, selector) {
  const values = valuesForKind(state, selector.kind);
  return values.find((value, index) => matchesSelector(value, selector, index + 1)) || null;
}

function matchesSelector(value, selector, index) {
  if (selector.id !== undefined && String(value.id ?? value.targetId) !== String(selector.id)) return false;
  if (selector.name !== undefined && String(value.name ?? value.title ?? "") !== String(selector.name)) return false;
  if (selector.url !== undefined && String(value.url || "") !== String(selector.url)) return false;
  if (selector.path !== undefined && String(value.path || "") !== String(selector.path)) return false;
  if (selector.folder !== undefined && String(value.folder || "") !== String(selector.folder)) return false;
  if (selector.folderId !== undefined && String(value.folderId ?? value.parentId ?? "") !== String(selector.folderId)) return false;
  if (selector.index !== undefined && Number(value.index ?? index) !== Number(selector.index)) return false;
  return true;
}

function readProperty(value, property) {
  if (!property) return value ?? null;
  if (property === "url") return value.url ?? null;
  if (property === "name") {
    return value.name ?? value.title ?? null;
  }
  if (property === "title") return value.title ?? value.name ?? null;
  if (property === "givenName") return value.givenName ?? value.name ?? null;
  if (property === "activeTab") return value.activeTab ?? null;
  return value[property] ?? null;
}

function extractFileArgument(expression) {
  const position = findPhraseOutsideQuotes(expression, " in file ");
  if (position < 0) return null;
  const before = expression.slice(0, position);
  let rest = expression.slice(position + " in file ".length).trim();
  if (/^posix\s+file\s+/i.test(rest)) rest = rest.replace(/^posix\s+file\s+/i, "");
  const literal = consumeLiteral(rest);
  if (!literal) return null;
  let suffix = literal.rest.trim();
  let format;
  if (suffix) {
    const as = suffix.match(/^as\s+(.+)$/i);
    if (!as) return null;
    format = parseLiteral(as[1]);
  }
  return { before, path: resolve(String(literal.value)), as: format };
}

function parseRecord(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
      "with properties requires an AppleScript record such as {name:\"Example\"}",
    );
  }
  const record = {};
  for (const part of splitTopLevel(text.slice(1, -1), ",")) {
    const separator = findTopLevelSeparator(part, [":", "="]);
    if (separator < 0) {
      throwAppleScript(
        "EGO_APPLESCRIPT_UNSUPPORTED_SYNTAX",
        `invalid AppleScript property record: ${part}`,
      );
    }
    const key = unquote(part.slice(0, separator).trim()).toLowerCase();
    record[key] = parseLiteral(part.slice(separator + 1));
  }
  return record;
}

function consumeLiteral(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return {
          value: unquote(text.slice(0, index + 1)),
          rest: text.slice(index + 1),
        };
      }
    }
    return null;
  }
  const match = text.match(/^(true|false|missing\s+value|[-+]?\d+(?:\.\d+)?)(?:\s|$)/i);
  if (!match) return null;
  return { value: parseLiteral(match[1]), rest: text.slice(match[1].length) };
}

function parseLiteral(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith('"') && text.endsWith('"')) return unquote(text);
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^missing\s+value$/i.test(text)) return null;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(?:\d+\.\d*|\d*\.\d+)$/.test(text)) return Number(text);
  return text;
}

function unquote(value) {
  const text = String(value || "").trim();
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  let result = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length - 1) {
      result += text[++index];
    } else if (char === '"' && text[index + 1] === '"') {
      result += '"';
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

function normalizeOpenTarget(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) return text;
  if (text.startsWith("/") || text.startsWith("./") || text.startsWith("../")) {
    return pathToFileURL(resolve(text)).toString();
  }
  return text;
}

function assertSupportedApplication(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!APPLICATION_NAMES.has(name)) {
    throwAppleScript(
      "EGO_APPLESCRIPT_UNSUPPORTED_APPLICATION",
      `unsupported tell application target: ${String(value || "")}`,
      { supported: [...APPLICATION_NAMES].sort() },
    );
  }
}

function stripComments(source) {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === "-" && next === "-") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
    } else {
      result += char;
    }
  }
  return result;
}

function splitStatements(value) {
  return splitTopLevel(value, [";", "\n"]);
}

function splitTopLevel(value, separators) {
  const result = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (braces === 0 && separators.includes(char)) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function compactWhitespace(value) {
  let result = "";
  let quoted = false;
  let pendingSpace = false;
  for (const char of String(value || "")) {
    if (quoted) {
      result += char;
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      if (pendingSpace && result && !result.endsWith(" ")) result += " ";
      pendingSpace = false;
      quoted = true;
      result += char;
    } else if (/\s/.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && result && !result.endsWith(" ")) result += " ";
      pendingSpace = false;
      result += char;
    }
  }
  return result.trim();
}

function splitFirstPhrase(value, phrase) {
  const index = findPhraseOutsideQuotes(value, phrase);
  if (index < 0) return null;
  return {
    before: value.slice(0, index),
    after: value.slice(index + phrase.length),
  };
}

function findPhraseOutsideQuotes(value, phrase) {
  const source = String(value || "");
  const wanted = phrase.toLowerCase();
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= source.length - wanted.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (source.slice(index, index + wanted.length).toLowerCase() === wanted) {
      return index;
    }
  }
  return -1;
}

function findWordOutsideQuotes(value, word) {
  const source = String(value || "");
  const wanted = word.toLowerCase();
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= source.length - wanted.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (source.slice(index, index + wanted.length).toLowerCase() !== wanted) continue;
    const before = source[index - 1];
    const after = source[index + wanted.length];
    if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) return index;
  }
  return -1;
}

function findTopLevelSeparator(value, separators) {
  let quoted = false;
  let braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "{") braces += 1;
    else if (!quoted && char === "}") braces = Math.max(0, braces - 1);
    else if (!quoted && braces === 0 && separators.includes(char)) return index;
  }
  return -1;
}

function throwAppleScript(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
