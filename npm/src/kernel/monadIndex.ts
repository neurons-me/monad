import type { Memory } from "this.me";
import type { SelfSurfaceTrust, SelfSurfaceType } from "../http/selfMapping.js";
import type { MonadRuntimeConfig } from "../bootstrap.js";
import { getKernel, saveSnapshot } from "./manager.js";

export interface MonadIndexEntry {
  monad_id: string;
  namespace: string;
  endpoint: string;
  name?: string;
  type?: SelfSurfaceType;
  trust?: SelfSurfaceTrust;
  public_key?: string;
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

  return [...latest.values()].filter((v): v is MonadIndexEntry => v !== null);
}

export function seedSelfMonadIndexEntry(config: MonadRuntimeConfig): void {
  const self = config.selfNodeConfig;
  if (!self?.monadId) return;

  const now = Date.now();
  const existing = readMonadIndexEntry(self.monadId);
  writeMonadIndexEntry(
    {
      monad_id: self.monadId,
      namespace: self.identity,
      endpoint: self.endpoint,
      name: self.monadName,
      type: self.type,
      trust: self.trust,
      public_key: self.publicKey,
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
