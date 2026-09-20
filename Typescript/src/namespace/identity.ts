import os from "os";
// @ts-ignore — cleaker ships named exports at runtime but its .d.ts only declares a default
import { composeNamespace, parseNamespaceExpression } from "cleaker";

export interface NamespaceIdentityParts {
  host: string;
  username: string;
  effective: string;
}

export const DEFAULT_LOCAL_NAMESPACE_ROOT = "monad.local";

/**
 * Labels that are never a person's handle. `www.<root>` is the root itself
 * (the place where a handle is claimed), and `api.<root>` is an address of the
 * service, so neither may be claimed as `<handle>.<root>`.
 */
export const RESERVED_HANDLE_LABELS: ReadonlySet<string> = new Set(["www", "api"]);

export function isReservedHandleLabel(label: unknown): boolean {
  return RESERVED_HANDLE_LABELS.has(String(label ?? "").trim().toLowerCase());
}

/** True for `www.<something>` / `api.<something>`: a reserved label in the handle position. */
export function hasReservedHandleLabel(namespace: unknown): boolean {
  const text = String(namespace ?? "").trim().toLowerCase();
  const dot = text.indexOf(".");
  return dot > 0 && isReservedHandleLabel(text.slice(0, dot));
}

/**
 * `www.cleaker.me` is `cleaker.me`: the front door of a namespace is the
 * namespace. Only a leading `www` label over a name that still has a dot is
 * dropped, so a bare `www` or `www.localhost` is left alone.
 */
export function stripWwwLabel(hostname: string): string {
  const text = String(hostname ?? "");
  return /^www\.[^.]+\./i.test(text) ? text.slice(4) : text;
}

function normalizeRawNamespace(input: unknown): string {
  return String(input || "").trim().toLowerCase();
}

function stripPort(raw: string): string {
  return String(raw || "").trim().toLowerCase().replace(/:\d+$/i, "");
}

function normalizeHostLike(raw: string): string {
  const value = stripPort(raw)
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value;
}

function isLoopbackishHost(raw: string): boolean {
  const host = stripPort(raw);
  return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/.test(host);
}

function parseLegacyUserNamespace(raw: string): { host: string; username: string; namespace: string } | null {
  const match = String(raw || "").trim().toLowerCase().match(/^([^/\[]+)\/users\/([^/\[]+)$/i);
  if (!match) return null;

  const host = String(match[1] || "").trim().toLowerCase();
  const username = String(match[2] || "").trim().toLowerCase();
  if (!host || !username) return null;

  return {
    host,
    username,
    namespace: `${host}/users/${username}`,
  };
}

function tryParseNamespace(raw: string) {
  try {
    return parseNamespaceExpression(raw);
  } catch {
    return null;
  }
}

function resolveLocalNamespaceRoot(): string {
  const configured = normalizeRawNamespace(
    process.env.MONAD_LOCAL_ALIAS_ROOT ||
      process.env.ME_NAMESPACE ||
      process.env.MONAD_SELF_IDENTITY ||
      process.env.MONAD_SELF_HOSTNAME ||
      "",
  );
  if (configured) {
    const parsed = tryParseNamespace(configured);
    const constant = stripPort(parsed?.constant || configured);
    if (constant) return constant;
  }

  const host = normalizeHostLike(String(os.hostname() || ""));
  if (host) {
    return host.includes(".") ? host : `${host}.local`;
  }

  return DEFAULT_LOCAL_NAMESPACE_ROOT;
}

function canonicalizeNamespaceConstant(input: unknown): string {
  const constant = stripPort(String(input || ""));
  if (!constant) return "";
  if (isLoopbackishHost(constant)) {
    return resolveLocalNamespaceRoot();
  }
  return constant;
}

function composeIdentityNamespace(prefix: string | null, constant: string): string {
  const normalizedPrefix = String(prefix || "").trim().toLowerCase();
  const normalizedConstant = canonicalizeNamespaceConstant(constant);
  if (!normalizedConstant) return normalizedPrefix;
  if (!normalizedPrefix) return normalizedConstant;

  try {
    return composeNamespace(normalizedPrefix, normalizedConstant);
  } catch {
    return `${normalizedPrefix}.${normalizedConstant}`;
  }
}

export function normalizeNamespaceIdentity(input: unknown): string {
  const raw = normalizeRawNamespace(input);
  if (!raw) return "";

  const legacy = parseLegacyUserNamespace(raw);
  if (legacy) return composeIdentityNamespace(legacy.username, legacy.host);

  const parsed = tryParseNamespace(raw);
  if (parsed) {
    return composeIdentityNamespace(parsed.prefix || null, parsed.constant || raw);
  }

  return canonicalizeNamespaceConstant(raw);
}

export function normalizeNamespaceConstant(input: unknown): string {
  const raw = normalizeRawNamespace(input);
  if (!raw) return "";

  const legacy = parseLegacyUserNamespace(raw);
  if (legacy) return canonicalizeNamespaceConstant(legacy.host);

  const parsed = tryParseNamespace(raw);
  return canonicalizeNamespaceConstant(parsed?.constant || raw);
}

export function normalizeNamespaceRootName(input: unknown): string {
  return normalizeNamespaceConstant(input);
}

export function isProjectableNamespaceRoot(input: unknown): boolean {
  const raw = normalizeNamespaceIdentity(input);
  if (!raw) return false;
  if (parseLegacyUserNamespace(raw)) return false;

  const parsed = tryParseNamespace(raw);
  if (parsed) return !parsed.prefix;

  return Boolean(normalizeNamespaceConstant(raw));
}

export function composeProjectedNamespace(username: string, rootNamespace: string): string {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const constant = normalizeNamespaceConstant(rootNamespace);
  if (!normalizedUsername) return constant;
  if (!constant) return normalizedUsername;

  try {
    return composeNamespace(normalizedUsername, constant);
  } catch {
    return `${normalizedUsername}.${constant}`;
  }
}

export function parseNamespaceIdentityParts(input: unknown): NamespaceIdentityParts {
  const namespace = normalizeNamespaceIdentity(input);
  if (!namespace) {
    return {
      host: "unknown",
      username: "",
      effective: "unclaimed",
    };
  }

  const legacy = parseLegacyUserNamespace(namespace);
  if (legacy) {
    return {
      host: legacy.host,
      username: legacy.username,
      effective: `@${legacy.username}.${legacy.host}`,
    };
  }

  const parsed = tryParseNamespace(namespace);
  if (parsed) {
    const host = parsed.constant || namespace;
    const username = parsed.prefix || "";
    return {
      host,
      username,
      effective: username ? `@${username}.${host}` : `@${host}`,
    };
  }

  return {
    host: namespace,
    username: "",
    effective: `@${namespace}`,
  };
}
