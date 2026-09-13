import type express from "express";
import {
  composeProjectedNamespace,
  isProjectableNamespaceRoot,
  normalizeNamespaceConstant,
  normalizeNamespaceIdentity,
  parseNamespaceIdentityParts,
} from "../namespace/identity.js";
import { resolveHostToMeUri } from "../runtime/hostResolver.js";

export type ObserverRelationMode = "raw" | "self" | "observer" | "view";

export interface ObserverRelation {
  operator: "?";
  mode: ObserverRelationMode;
  value: string | null;
  observer: string | null;
  namespace: string | null;
}

export function createRawObserverRelation(): ObserverRelation {
  return {
    operator: "?",
    mode: "raw",
    value: null,
    observer: null,
  namespace: null,
  };
}

function firstHeaderValue(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || "").split(",")[0].trim();
}

function normalizeHostToken(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .trim();
}

function readLocalIdentityNamespace(hostnameOnly: string): string | null {
  const host = normalizeHostToken(hostnameOnly);
  if (!host) return null;

  const identity = normalizeNamespaceIdentity(
    process.env.MONAD_SELF_IDENTITY ||
    process.env.ME_NAMESPACE ||
    "",
  );
  if (!identity) return null;

  const aliases = new Set<string>([
    normalizeHostToken(process.env.MONAD_SELF_HOSTNAME || ""),
    normalizeHostToken(process.env.MONAD_SELF_ENDPOINT || ""),
    ...String(process.env.MONAD_SELF_TAGS || "")
      .split(",")
      .map((value) => normalizeHostToken(value))
      .filter((value) => value.includes(".") || value === "localhost"),
  ].filter(Boolean));

  return aliases.has(host) ? identity : null;
}

function readForwardedHost(req: express.Request): string {
  const forwarded = firstHeaderValue(req.headers.forwarded as string | string[] | undefined);
  if (forwarded) {
    const match = forwarded.match(/(?:^|;|\s)host="?([^;,\s"]+)"?/i);
    if (match?.[1]) return match[1].trim();
  }

  return firstHeaderValue(req.headers["x-forwarded-host"]);
}

export function resolveHostNamespace(req: express.Request) {
  const hostHeaderRaw = readForwardedHost(req) || firstHeaderValue(req.headers.host) || "";

  const first = String(hostHeaderRaw).split(",")[0].trim();
  const noProto = first.replace(/^https?:\/\//i, "");
  const hostnameOnly = noProto.split(":")[0].trim();

  const projected = resolveHostToMeUri(hostnameOnly);
  if (projected.ok) return projected.namespace;

  const localIdentity = readLocalIdentityNamespace(hostnameOnly);
  if (localIdentity) return localIdentity;

  // Host is client-supplied transport metadata, not a verified identity claim
  // (see all.this/CLAUDE.md "Known architectural gaps" #1/#2 — surface claims
  // aren't implemented yet, so we must not invent a parallel trust path here).
  // A hostname that doesn't fall under one of this monad's own known
  // spaces/aliases (UNKNOWN_SPACE / INVALID_HOST / NOT_CANONICAL_NAMESPACE)
  // must not be trusted as a namespace selector — otherwise any caller could
  // read another namespace's ledger just by forging Host. The one case kept
  // is TRANSPORT_ONLY_HOST (localhost/.local mDNS addressing): the network
  // layer, not the header, is what put the caller on that name, and existing
  // LAN/direct-daemon routing already depends on trusting it literally.
  if (projected.reason === "TRANSPORT_ONLY_HOST") {
    return normalizeNamespaceIdentity(hostnameOnly) || "unknown";
  }

  return "unknown";
}

export function resolveTransportHost(req: express.Request) {
  const hostHeaderRaw = firstHeaderValue(req.headers.host);
  const first = String(hostHeaderRaw).split(",")[0].trim();
  const noProto = first.replace(/^https?:\/\//i, "");
  const hostnameOnly = noProto.split(":")[0].trim();
  return hostnameOnly || "unknown";
}

export function isReservedLabel(label: string) {
  const x = String(label || "").toLowerCase();
  return x === "www" || x === "api";
}

export function isProjectableRootHost(hostname: string) {
  return isProjectableNamespaceRoot(hostname);
}

export function normalizeUsernameLabel(raw: string) {
  const x = String(raw || "").trim().toLowerCase();
  const safe = x.replace(/[^a-z0-9_-]/g, "");
  if (!safe) return "";
  if (isReservedLabel(safe)) return "";
  return safe;
}

export function canonicalPair(a: string, b: string) {
  const A = normalizeUsernameLabel(a);
  const B = normalizeUsernameLabel(b);
  if (!A || !B) return "";
  const pair = [A, B].sort();
  return `${pair[0]}+${pair[1]}`;
}

export function getAtSelectorFromPath(req: express.Request) {
  const p = String(req.path || "");
  const m = p.match(/^\/\@([^\/\?#]+)(?:\/|$)/);
  if (!m) return null;
  const raw = String(m[1] || "").trim();
  if (!raw) return null;

  if (raw.includes("+")) {
    const parts = raw.split(/\+\+?/).map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    const pair = canonicalPair(parts[0], parts[1]);
    if (!pair) return null;
    return { kind: "relation" as const, pair };
  }

  const username = normalizeUsernameLabel(raw);
  if (!username) return null;
  return { kind: "user" as const, username };
}

export function getAtNestedUserFromPath(req: express.Request) {
  const p = String(req.path || "");
  const m = p.match(/^\/\@([^\/\?#]+)\/\@([^\/\?#]+)(?:\/|$)/);
  if (!m) return null;
  const a = normalizeUsernameLabel(String(m[1] || ""));
  const b = normalizeUsernameLabel(String(m[2] || ""));
  if (!a || !b) return null;
  return { a, b };
}

export function resolveChainNamespace(req: express.Request) {
  const host = normalizeNamespaceIdentity(resolveHostNamespace(req));
  if (!host) return "unknown";

  const atSel = getAtSelectorFromPath(req);
  const atNested = getAtNestedUserFromPath(req);
  const rootProjectable = isProjectableRootHost(host);

  if (atNested) {
    return rootProjectable ? composeProjectedNamespace(atNested.a, host) : host;
  }

  if (atSel?.kind === "relation") {
    return host;
  }

  if (atSel?.kind === "user") {
    return rootProjectable ? composeProjectedNamespace(atSel.username, host) : host;
  }

  return host;
}

export function resolveNamespace(req: express.Request) {
  return resolveChainNamespace(req);
}

export function resolveNamespaceProjectionRoot(namespace: string) {
  return normalizeNamespaceConstant(namespace);
}

function normalizeNamespaceReference(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._/\-:\[\]]/g, "");
}

function resolveObserverReference(raw: string): { observer: string; namespace: string | null } | null {
  const normalized = normalizeNamespaceReference(raw);
  if (!normalized) return null;

  if (
    normalized.includes(".") ||
    normalized.includes("/") ||
    normalized.includes("[") ||
    normalized.includes(":") ||
    normalized.startsWith("me://") ||
    normalized.startsWith("nrp://")
  ) {
    const namespace = normalizeNamespaceIdentity(normalized);
    const identity = parseNamespaceIdentityParts(namespace);
    return {
      observer: identity.username || namespace,
      namespace,
    };
  }

  const observer = normalizeUsernameLabel(normalized);
  if (!observer) return null;
  return {
    observer,
    namespace: null,
  };
}

export function resolveObserverRelation(req: express.Request): ObserverRelation {
  const q: any = req.query || {};
  const asRaw = String(q.as ?? "").trim();
  if (asRaw) {
    const targetNamespace = resolveNamespace(req);
    const projectionRoot =
      resolveNamespaceProjectionRoot(targetNamespace) || resolveHostNamespace(req);
    const resolved = resolveObserverReference(asRaw);
    if (!resolved) return createRawObserverRelation();

    const observerNamespace = resolved.namespace
      ? resolved.namespace
      : isProjectableRootHost(projectionRoot)
        ? composeProjectedNamespace(resolved.observer, projectionRoot)
        : resolved.observer;

    return {
      operator: "?",
      mode: "observer",
      value: asRaw,
      observer: resolved.observer,
      namespace: observerNamespace,
    };
  }

  const me = String(q.me ?? "").trim().toLowerCase();
  if (me === "1" || me === "true") {
    const namespace = resolveNamespace(req);
    return {
      operator: "?",
      mode: "self",
      value: "me",
      observer: "self",
      namespace,
    };
  }

  const view = String(q.view ?? "").trim().toLowerCase();
  if (view) {
    return {
      operator: "?",
      mode: "view",
      value: view,
      observer: null,
      namespace: null,
    };
  }

  return createRawObserverRelation();
}

export function formatObserverRelationLabel(relation: ObserverRelation) {
  if (relation.mode === "observer") {
    return relation.namespace
      ? `as:${relation.namespace}`
      : relation.observer
        ? `as:${relation.observer}`
        : "as";
  }

  if (relation.mode === "self") return "me";
  if (relation.mode === "view") return relation.value || "view";
  return "raw";
}

export function formatObserverRelationQuery(relation: ObserverRelation) {
  if (relation.mode === "observer") {
    const value = relation.namespace || relation.observer || relation.value;
    return value ? `?as=${encodeURIComponent(value)}` : "";
  }

  if (relation.mode === "self") {
    return "?me=true";
  }

  if (relation.mode === "view") {
    return relation.value ? `?view=${encodeURIComponent(relation.value)}` : "";
  }

  return "";
}

export function resolveLens(req: express.Request) {
  return formatObserverRelationLabel(resolveObserverRelation(req));
}

export function filterBlocksByNamespace(allBlocks: any[], ns: string) {
  if (!ns) return allBlocks;
  const slashPrefix = ns.endsWith("/") ? ns : `${ns}/`;
  const dotSuffix = `.${ns}`;
  const bracketPrefix = `${ns}[`;
  return allBlocks.filter((b: any) => {
    const n = String(b?.namespace || "");
    return n === ns || n.startsWith(slashPrefix) || n.endsWith(dotSuffix) || n.startsWith(bracketPrefix);
  });
}
