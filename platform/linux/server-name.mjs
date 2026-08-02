import { join } from "node:path";

export const DEFAULT_SERVER_NAME = "default";

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function normalizeServerName(value, { strict = false } = {}) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return DEFAULT_SERVER_NAME;
  if (SERVER_NAME_PATTERN.test(candidate)) return candidate;
  if (strict) {
    throw new Error(
      "server name must start with a letter or number and contain only letters, numbers, hyphens, or underscores",
    );
  }
  return DEFAULT_SERVER_NAME;
}

export function serverDataRoot(baseRoot, serverName) {
  const normalized = normalizeServerName(serverName);
  return normalized === DEFAULT_SERVER_NAME
    ? baseRoot
    : join(baseRoot, "servers", normalized);
}
