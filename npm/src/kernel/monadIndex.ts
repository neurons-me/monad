import type { Memory } from "this.me";
import type { SelfSurfaceTrust, SelfSurfaceType } from "../http/selfMapping.js";
import type { MonadRuntimeConfig } from "../bootstrap.js";
import { listMonadRecords } from "../cli/runtime.js";
import { getKernel, saveSnapshot } from "./manager.js";

export interface MonadIndexEntry {
  monad_id: string;
  namespace: string;
  endpoint: string;
  name?: string;
  type?: SelfSurfaceType;
  trust?: SelfSurfaceTrust;
  public_key?: string;
  tags?: string[];
  claimed_namespaces?: string[];
  first_seen: number;
  last_seen: number;
  version?: string;
  capabilities?: string[];
}

// Secret space path — encrypted at snapshot/persist time, plain in live memory.
const INDEX_ROOT = "_.mesh.monads";

function monadKey(monadId: string): string {
  return monadId.replace(/[^a-z0-9_.-]/g, "_");
}

// Navigate proxy chain by dot-path and call the leaf node to write.
// NOTE: (kernel as any)[fullDottedPath] does NOT traverse — it treats the
// entire dotted string as a single key. Traversal requires step-by-step access.
function nav(root: any, path: string): any {
  return path.split(".").reduce((proxy: any, key: string) => proxy[key], root);
}

export function writeMonadIndexEntry(entry: MonadIndexEntry, persist = false): void {
  nav(getKernel(), `${INDEX_ROOT}.${monadKey(entry.monad_id)}`)(entry);
  if (persist) saveSnapshot();
}

export function readMonadIndexEntry(monadId: string): MonadIndexEntry | undefined {
  const kernelRead = getKernel() as unknown as (path: string) => unknown;
  const result = kernelRead(`${INDEX_ROOT}.${monadKey(monadId)}`);
  return result !== null && result !== undefined && typeof result === "object"
    ? (result as MonadIndexEntry)
    : undefined;
}

export function listMonadIndex(): MonadIndexEntry[] {
  const prefix = `${INDEX_ROOT}.`;
  const mems = ((getKernel() as any).memories ?? []) as Memory[];
  const latest = new Map<string, MonadIndexEntry | null>();

  for (const mem of mems) {
    if (!mem.path.startsWith(prefix)) continue;
    // Only care about top-level entries, not sub-field writes.
    const key = mem.path.slice(prefix.length).split(".")[0];
    if (!key) continue;
    if (mem.operator === "-") {
      latest.set(key, null);
    } else if (mem.value !== null && mem.value !== undefined && typeof mem.value === "object" && "monad_id" in (mem.value as object)) {
      latest.set(key, mem.value as MonadIndexEntry);
    }
  }

  return [...latest.values()]
    .filter((v): v is MonadIndexEntry => v !== null)
    .sort(byRecency);
}

export function seedSelfMonadIndexEntry(config: MonadRuntimeConfig): void {
  const self = config.selfNodeConfig;
  if (!self?.monadId) return;

  const now = Date.now();
  const existing = readMonadIndexEntry(self.monadId);
  // Include: existing claims + identity + any tags that look like hostnames
  // (tags with a dot or "localhost" are real hostnames, not labels like "primary").
  const tagClaims = (self.tags ?? []).filter((t) => t.includes(".") || t === "localhost");
  const claimed = Array.from(
    new Set(
      [...(existing?.claimed_namespaces ?? []), self.identity, ...tagClaims].filter(Boolean),
    ),
  );
  writeMonadIndexEntry(
    {
      monad_id: self.monadId,
      namespace: self.identity,
      endpoint: self.endpoint,
      name: self.monadName,
      type: self.type,
      trust: self.trust,
      public_key: self.publicKey,
      tags: self.tags ?? [],
      capabilities: self.resources ?? [],
      claimed_namespaces: claimed,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    },
    true,
  );
}

export function touchSelfMonadLastSeen(monadId: string): void {
  const existing = readMonadIndexEntry(monadId);
  if (!existing) return;
  writeMonadIndexEntry({ ...existing, last_seen: Date.now() });
}

function normalizeNs(ns: string): string {
  return String(ns || "").trim().toLowerCase();
}

function byRecency(a: MonadIndexEntry, b: MonadIndexEntry): number {
  const t = b.last_seen - a.last_seen;
  if (t !== 0) return t;
  return (a.name ?? a.monad_id).localeCompare(b.name ?? b.monad_id);
}

// Returns all index entries that claim to serve targetNs (namespace or rootspace).
// Results are sorted by last_seen desc (most recent first).
export function findMonadsForNamespace(targetNs: string): MonadIndexEntry[] {
  const target = normalizeNs(targetNs);
  if (!target) return [];
  return listMonadIndex().filter((entry) => {
    if (normalizeNs(entry.namespace) === target) return true;
    return (entry.claimed_namespaces ?? []).some((ns) => normalizeNs(ns) === target);
  });
}

// Find a monad by name (case-insensitive) or by full monad_id.
export function findMonadByName(nameOrId: string): MonadIndexEntry | undefined {
  const q = String(nameOrId || "").trim().toLowerCase();
  if (!q) return undefined;
  return listMonadIndex().find(
    (entry) =>
      (entry.name?.toLowerCase() === q) ||
      entry.monad_id === nameOrId ||
      normalizeNs(entry.monad_id) === q,
  );
}

// Add extra namespaces to this monad's claimed set (called after a claim ceremony).
export function announceClaimedNamespaces(monadId: string, namespaces: string[]): void {
  const existing = readMonadIndexEntry(monadId);
  if (!existing) return;
  const merged = Array.from(
    new Set([...(existing.claimed_namespaces ?? []), ...namespaces].filter(Boolean)),
  );
  writeMonadIndexEntry({ ...existing, claimed_namespaces: merged }, true);
}

// ── CLI-backed async discovery ────────────────────────────────────────────────
// Each monad has its own isolated kernel. The shared state across all locally
// running monads lives in ~/.monad/monads/*/monad.json (the CLI record store).
// These async helpers merge local kernel entries with CLI filesystem records.

function cliRecordToEntry(r: Awaited<ReturnType<typeof listMonadRecords>>[number]): MonadIndexEntry {
  const ns = normalizeNs(r.namespace || r.identity || "");
  return {
    monad_id: `cli:${r.name}`,
    namespace: ns || r.name,
    endpoint: r.endpoint,
    name: r.name,
    claimed_namespaces: ns ? [ns] : [],
    first_seen: new Date(r.startedAt).getTime() || Date.now(),
    last_seen: new Date(r.updatedAt).getTime() || Date.now(),
  };
}

// Async version: local kernel + CLI records, deduplicated by endpoint.
export async function findMonadsForNamespaceAsync(targetNs: string): Promise<MonadIndexEntry[]> {
  const target = normalizeNs(targetNs);
  if (!target) return [];

  const kernelEntries = findMonadsForNamespace(targetNs);
  let cliEntries: MonadIndexEntry[] = [];

  try {
    const records = await listMonadRecords();
    cliEntries = records
      .filter((r) => {
        const ns = normalizeNs(r.namespace || r.identity);
        return ns === target;
      })
      .map(cliRecordToEntry);
  } catch {
    // CLI home may not exist during dev runs
  }

  // Kernel entries take priority; CLI entries fill gaps not already in kernel.
  const seenEndpoints = new Set(kernelEntries.map((e) => normalizeNs(e.endpoint)));
  const merged = [
    ...kernelEntries,
    ...cliEntries.filter((e) => !seenEndpoints.has(normalizeNs(e.endpoint))),
  ];

  return merged.sort(byRecency);
}

// Async version: local kernel name lookup + CLI fallback.
export async function findMonadByNameAsync(nameOrId: string): Promise<MonadIndexEntry | undefined> {
  const kernelResult = findMonadByName(nameOrId);
  if (kernelResult) return kernelResult;

  const q = String(nameOrId || "").trim().toLowerCase();
  try {
    const records = await listMonadRecords();
    const match = records.find((r) => r.name.toLowerCase() === q);
    if (match) return cliRecordToEntry(match);
  } catch {}

  return undefined;
}

// Async version of listMonadIndex: local kernel + all CLI-known monads.
export async function listMonadIndexAsync(): Promise<MonadIndexEntry[]> {
  const kernelEntries = listMonadIndex();
  let cliEntries: MonadIndexEntry[] = [];

  try {
    const records = await listMonadRecords();
    cliEntries = records.map(cliRecordToEntry);
  } catch {}

  const seenEndpoints = new Set(kernelEntries.map((e) => normalizeNs(e.endpoint)));
  const merged = [
    ...kernelEntries,
    ...cliEntries.filter((e) => !seenEndpoints.has(normalizeNs(e.endpoint))),
  ];

  return merged.sort(byRecency);
}
