import parseTarget from "cleaker";
import type express from "express";
import { buildMeTargetNrp } from "../http/meTarget.js";
import {
  resolveObserverRelation,
  resolveTransportHost,
  type ObserverRelation,
} from "../http/namespace.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";

export type BridgeTarget = {
  namespace: string;
  selector: string;
  pathSlash: string;
  pathDot: string;
  nrp: string;
  /** Extracted monad name from `monad[frank]` path syntax. */
  monadId?: string | null;
  /** Remaining path after `monad[frank]/` — the path to proxy to the selected monad. */
  monadScopePath?: string | null;
};

export type NamespaceSelectorInfo = {
  base: string;
  selectorRaw: string | null;
  webTarget: string | null;
  hasDevice: boolean;
};

export function extractNamespaceSelector(namespace: string): { base: string; selectorRaw: string | null } {
  const raw = String(namespace || "").trim();
  if (!raw) return { base: "", selectorRaw: null };
  const match = raw.match(/^([^\[]+)(?:\[(.*)\])?$/);
  if (!match) return { base: raw, selectorRaw: null };
  return {
    base: String(match[1] || "").trim(),
    selectorRaw: match[2] === undefined ? null : String(match[2] || "").trim(),
  };
}

export function findSelectorValue(selectorRaw: string, selectorType: string): string | null {
  const type = String(selectorType || "").trim().toLowerCase();
  if (!type) return null;
  const groups = selectorRaw.split("|").map((p) => p.trim()).filter(Boolean);
  for (const group of groups) {
    const parts = group.split(";").map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const head = part.slice(0, colon).trim().toLowerCase();
      if (!head || head !== type) continue;
      const rest = part.slice(colon + 1).trim();
      if (!rest) continue;
      const value = rest.split(",")[0]?.trim();
      if (value) return value;
    }
  }
  return null;
}

export function normalizeWebUrl(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, "")}`;
}

export function getNamespaceSelectorInfo(namespace: string): NamespaceSelectorInfo {
  const { base, selectorRaw } = extractNamespaceSelector(namespace);
  if (!selectorRaw) return { base, selectorRaw: null, webTarget: null, hasDevice: false };
  const webValue = findSelectorValue(selectorRaw, "web");
  const webTarget = webValue ? normalizeWebUrl(webValue) : null;
  const deviceValue = findSelectorValue(selectorRaw, "device");
  const hostValue = findSelectorValue(selectorRaw, "host");
  const hasDevice = !!(deviceValue || hostValue);
  return { base, selectorRaw, webTarget, hasDevice };
}

/**
 * Detects `monad[frank]` at the start of a path segment and extracts the monad
 * name plus any remaining path. Returns null when the pattern is absent.
 */
export function extractMonadFromPath(pathSlash: string): { monadId: string; remainingPath: string } | null {
  const match = String(pathSlash || "").match(/^monad\[([^\]]+)\](?:\/(.*))?$/);
  if (!match) return null;
  const monadId = String(match[1] || "").trim().toLowerCase();
  if (!monadId) return null;
  return { monadId, remainingPath: String(match[2] || "").trim() };
}

export function parseBridgeTarget(rawInput: string): BridgeTarget | null {
  const raw = String(rawInput || "").trim();
  if (!raw) return null;
  try {
    const parsed = parseTarget(raw.startsWith("me://") ? raw : `me://${raw}`, { allowShorthandRead: true });
    const t = (parsed as any).__ptr?.target ?? parsed;
    const namespace = normalizeNamespaceIdentity(t.namespace?.fqdn ?? t.namespace ?? "");
    if (!namespace) return null;
    const selector = String(t.operation || t.intent?.selector || "read").trim() || "read";
    const pathSlash = String(t.path || "").trim().replace(/^\/+/, "");
    const pathDot = pathSlash.split("/").map((p) => p.trim()).filter(Boolean).join(".");
    const nrp = `me://${namespace}:${selector}/${pathDot || "_"}`;
    const monadExtract = extractMonadFromPath(pathSlash);
    return {
      namespace,
      selector,
      pathSlash,
      pathDot,
      nrp,
      ...(monadExtract ? { monadId: monadExtract.monadId, monadScopePath: monadExtract.remainingPath } : {}),
    };
  } catch {
    return null;
  }
}

export function buildBridgeTarget(
  resolved: BridgeTarget | null,
  requestHost: string,
  relation: ObserverRelation,
  rawFallback = "",
) {
  const namespaceMe = resolved?.namespace || "unknown";
  const nrp = resolved
    ? buildMeTargetNrp(namespaceMe, "read", resolved.pathDot || "", relation)
    : rawFallback || buildMeTargetNrp(namespaceMe, "read", "", relation);
  return {
    namespace: { me: namespaceMe, host: requestHost },
    operation: "read" as const,
    path: resolved?.pathDot || "",
    nrp,
    relation,
  };
}

export function buildNormalizedTarget(
  req: express.Request,
  namespace: string,
  operation: "read" | "write" | "claim" | "open",
  path: string,
) {
  const host = resolveTransportHost(req) || "unknown";
  const relation = resolveObserverRelation(req);
  return {
    host,
    namespace,
    operation,
    path,
    nrp: buildMeTargetNrp(namespace, operation, path, relation),
    relation,
  };
}

export function buildKernelCommandTarget(
  req: express.Request,
  operation: "claim" | "open",
  path: string,
) {
  const host = resolveTransportHost(req) || "unknown";
  const normalizedPath = String(path || "").trim();
  const relation = resolveObserverRelation(req);
  return {
    host,
    namespace: "kernel",
    operation,
    path: normalizedPath || "_",
    nrp: buildMeTargetNrp("kernel", operation, normalizedPath || "_", relation),
    relation,
  };
}
