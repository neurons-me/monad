/**
 * gatewayRecordDisclosure.ts -- the gateway's domain records are reserved to the monad's internal service.
 *
 * netget keeps its domain records in this monad: `domains.<key>.*` under each owner's namespace and
 * `domainIndex.<key>` under netget's (the same physical place as `users.<owner>.domains.*` from the root).
 *
 * Policy: no monad output hands these records to anyone but the internal service -- not an anonymous reader, not a
 * signed-in caller, not the namespace's owner, including in the memories its own sign-in returns. The internal service
 * is whoever presents the monad's internal token (internalToken.ts), which on a gateway machine is netget: it already
 * shows it to write these records, and now to read them. netget then delivers what each caller is entitled to (its GET
 * /domains: the public projection domain/type/subdomain/tlsConfigured for anyone, the full configuration only for an
 * admin with gateway:read). The monad does not decide who may see what: it only refuses to be a second way out.
 *
 * The bypass is explicit and fails closed: only `mayReadGatewayRecords(req)` (the exact token, constant-time) opens it;
 * a missing, empty or wrong token, or a monad with no token configured, leaves the filter on. The stored chain is not
 * changed: the records stay in the kernel and in the snapshot; they are left out of the answer.
 *
 * Every generic read surface passes its answer through this module: ledger rows and blocks, branch trees, sync events,
 * sign-in memories, host history, inspection, explain, NRP. Covered representations: a row AT a record path (dropped
 * whole); a row or tree value at a PARENT path whose subtree contains a record (the record keys are pruned from a
 * copy); a read OF a record path (answered closed whether or not a record exists). Paths are compared after the same
 * normalization the write guard uses (dots or slashes, any number of users.<label>. prefixes), plus bracket segments
 * (`domains["k"]`, `domains[k]`), and for explain any wildcard or aggregate that could reach one. What it protects is
 * the records, by where they live -- not secrets by field name.
 */
import type express from "express";
import { isGatewayRoutingRecordPath, isInternalRequest } from "./internalToken.js";

const RECORD_HEADS = new Set(["domains", "domainIndex"]);

/** True when the request may see gateway records (the monad's internal caller). */
export function mayReadGatewayRecords(req: Pick<express.Request, "headers">): boolean {
  return isInternalRequest(req);
}

function segmentsOf(pathInput: string): string[] {
  return String(pathInput || "")
    .replace(/\[\s*["']?([^\]"']*)["']?\s*\]/g, ".$1")
    .replace(/\//g, ".")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A record path itself, or anything under one (bracket and slash spellings included). */
export function isGatewayRecordPath(pathInput: string): boolean {
  return isGatewayRoutingRecordPath(segmentsOf(pathInput).join("."));
}

function stripOwnerPrefixes(segs: string[]): string[] {
  let s = segs;
  while (s.length >= 2 && s[0] === "users") s = s.slice(2);
  return s;
}

/**
 * Could a read of this path (or path expression) return a record value? True for a record path, for a parent of one
 * (`users`, `users.<label>`, a namespace root), and for a wildcard where a record head could be. Used where the answer
 * cannot be pruned after the fact (explain, aggregates).
 */
export function mayReachGatewayRecords(pathInput: string): boolean {
  // Every path-like run inside an expression (`sum(users.x.domains[*].port)` -> `users.x.domains[*].port`).
  const runs = String(pathInput || "").match(/[A-Za-z0-9_\-.*/\[\]"']+/g) ?? [];
  if (!runs.length) return true;
  return runs.some((run) => {
    const segs = segmentsOf(run);
    if (!segs.length) return true;
    if (isGatewayRoutingRecordPath(segs.join("."))) return true;
    const rest = stripOwnerPrefixes(segs);
    if (!rest.length) return true; // users.<label> (a namespace's whole tree)
    if (rest.length === 1 && rest[0] === "users") return true; // the directory of every namespace
    const head = rest[0];
    return RECORD_HEADS.has(head) || head.includes("*"); // a record head, or a wildcard where one could be
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The value at `basePath` with every record subtree removed. Returns the same reference when nothing was removed, a
 * pruned copy otherwise (never mutates kernel data), and `undefined` when `basePath` is itself a record path.
 */
export function pruneGatewayRecords(basePath: string, value: unknown): unknown {
  const base = segmentsOf(basePath);
  if (base.length && isGatewayRoutingRecordPath(base.join("."))) return undefined;
  return pruneAt(base, value);
}

function pruneAt(base: string[], value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...base, ...segmentsOf(key)];
    if (isGatewayRoutingRecordPath(childPath.join("."))) {
      out ??= { ...value };
      delete out[key];
      continue;
    }
    const pruned = pruneAt(childPath, child);
    if (pruned !== child) {
      out ??= { ...value };
      out[key] = pruned;
    }
  }
  return out ?? value;
}

const VALUE_KEYS = ["value", "data", "expression"] as const;

/**
 * Rows of any shape that carry a `path` (memory rows, ledger blocks, replay memories, inspection memories): a row at a
 * record path is dropped; a row at a parent path keeps its place with the record keys pruned from its value fields.
 */
export function withoutGatewayRecordRows<T>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const r = row as unknown as Record<string, unknown>;
    const rowPath = String(r?.path ?? "");
    if (isGatewayRecordPath(rowPath)) continue;
    let copy: Record<string, unknown> | null = null;
    for (const k of VALUE_KEYS) {
      if (!(k in (r ?? {}))) continue;
      const pruned = pruneGatewayRecords(rowPath, r[k]);
      if (pruned !== r[k]) {
        copy ??= { ...r };
        copy[k] = pruned;
      }
    }
    out.push((copy ?? row) as T);
  }
  return out;
}

/** A path -> value index (the kernel's inspection index): record keys dropped, parent values pruned. */
export function withoutGatewayRecordIndex(index: unknown): unknown {
  if (!isPlainObject(index)) return index;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(index)) {
    if (isGatewayRecordPath(key)) continue;
    out[key] = pruneGatewayRecords(key, value);
  }
  return out;
}
