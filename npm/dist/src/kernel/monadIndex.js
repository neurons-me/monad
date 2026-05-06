import { listMonadRecords } from "../cli/runtime.js";
import { getKernel, saveSnapshot } from "./manager.js";
// Secret space path — encrypted at snapshot/persist time, plain in live memory.
const INDEX_ROOT = "_.mesh.monads";
function monadKey(monadId) {
    return monadId.replace(/[^a-z0-9_.-]/g, "_");
}
// Navigate proxy chain by dot-path and call the leaf node to write.
// NOTE: (kernel as any)[fullDottedPath] does NOT traverse — it treats the
// entire dotted string as a single key. Traversal requires step-by-step access.
function nav(root, path) {
    return path.split(".").reduce((proxy, key) => proxy[key], root);
}
/**
 * Writes or replaces a monad index entry in the local `.me` kernel.
 *
 * The index is the fast structural layer: it answers "who could serve this
 * namespace?" before the scoring engine decides "who should serve it?"
 */
export function writeMonadIndexEntry(entry, persist = false) {
    nav(getKernel(), `${INDEX_ROOT}.${monadKey(entry.monad_id)}`)(entry);
    if (persist)
        saveSnapshot();
}
/** Reads a single local-kernel monad index entry by stable monad id. */
export function readMonadIndexEntry(monadId) {
    const kernelRead = getKernel();
    const result = kernelRead(`${INDEX_ROOT}.${monadKey(monadId)}`);
    return result !== null && result !== undefined && typeof result === "object"
        ? result
        : undefined;
}
/**
 * Lists local-kernel index entries ordered by freshness.
 *
 * This does not include the CLI record store; use `listMonadIndexAsync` when
 * discovering sibling monads running in other processes on the same machine.
 */
export function listMonadIndex() {
    const prefix = `${INDEX_ROOT}.`;
    const mems = (getKernel().memories ?? []);
    const latest = new Map();
    for (const mem of mems) {
        if (!mem.path.startsWith(prefix))
            continue;
        // Only care about top-level entries, not sub-field writes.
        const key = mem.path.slice(prefix.length).split(".")[0];
        if (!key)
            continue;
        if (mem.operator === "-") {
            latest.set(key, null);
        }
        else if (mem.value !== null && mem.value !== undefined && typeof mem.value === "object" && "monad_id" in mem.value) {
            latest.set(key, mem.value);
        }
    }
    return [...latest.values()]
        .filter((v) => v !== null)
        .sort(byRecency);
}
/**
 * Seeds the current process into the local monad index.
 *
 * Host-like tags are projected into `claimed_namespaces`, while all tags remain
 * available for selector constraints.
 */
export function seedSelfMonadIndexEntry(config) {
    const self = config.selfNodeConfig;
    if (!self?.monadId)
        return;
    const now = Date.now();
    const existing = readMonadIndexEntry(self.monadId);
    // Include: existing claims + identity + any tags that look like hostnames
    // (tags with a dot or "localhost" are real hostnames, not labels like "primary").
    const tagClaims = (self.tags ?? []).filter((t) => t.includes(".") || t === "localhost");
    const claimed = Array.from(new Set([...(existing?.claimed_namespaces ?? []), self.identity, ...tagClaims].filter(Boolean)));
    writeMonadIndexEntry({
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
    }, true);
}
/** Updates the local heartbeat timestamp for this monad. */
export function touchSelfMonadLastSeen(monadId) {
    const existing = readMonadIndexEntry(monadId);
    if (!existing)
        return;
    writeMonadIndexEntry({ ...existing, last_seen: Date.now() });
}
function normalizeNs(ns) {
    return String(ns || "").trim().toLowerCase();
}
function byRecency(a, b) {
    const t = b.last_seen - a.last_seen;
    if (t !== 0)
        return t;
    return (a.name ?? a.monad_id).localeCompare(b.name ?? b.monad_id);
}
/**
 * Finds local-kernel monads that claim a namespace.
 *
 * Results are ordered by `last_seen`, with deterministic name/id tie-breaking.
 */
export function findMonadsForNamespace(targetNs) {
    const target = normalizeNs(targetNs);
    if (!target)
        return [];
    return listMonadIndex().filter((entry) => {
        if (normalizeNs(entry.namespace) === target)
            return true;
        return (entry.claimed_namespaces ?? []).some((ns) => normalizeNs(ns) === target);
    });
}
/** Finds a local-kernel monad by human name or full monad id. */
export function findMonadByName(nameOrId) {
    const q = String(nameOrId || "").trim().toLowerCase();
    if (!q)
        return undefined;
    return listMonadIndex().find((entry) => (entry.name?.toLowerCase() === q) ||
        entry.monad_id === nameOrId ||
        normalizeNs(entry.monad_id) === q);
}
/**
 * Adds namespaces to a monad's claimed set.
 *
 * This is the compatibility/fast-index layer. Rich per-namespace metadata lives
 * in `_.mesh.monads.<id>.claimed.<namespace>` and is read by the scoring engine.
 */
export function announceClaimedNamespaces(monadId, namespaces) {
    const existing = readMonadIndexEntry(monadId);
    if (!existing)
        return;
    const merged = Array.from(new Set([...(existing.claimed_namespaces ?? []), ...namespaces].filter(Boolean)));
    writeMonadIndexEntry({ ...existing, claimed_namespaces: merged }, true);
}
// ── CLI-backed async discovery ────────────────────────────────────────────────
// Each monad has its own isolated kernel. The shared state across all locally
// running monads lives in ~/.monad/monads/*/monad.json (the CLI record store).
// These async helpers merge local kernel entries with CLI filesystem records.
function cliRecordToEntry(r) {
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
/**
 * Finds namespace claimants across the local kernel and CLI record store.
 *
 * This is the bridge-facing discovery function. It sees sibling monad processes
 * because the CLI `monad.json` records are shared across processes.
 */
export async function findMonadsForNamespaceAsync(targetNs) {
    const target = normalizeNs(targetNs);
    if (!target)
        return [];
    const kernelEntries = findMonadsForNamespace(targetNs);
    let cliEntries = [];
    try {
        const records = await listMonadRecords();
        cliEntries = records
            .filter((r) => {
            const ns = normalizeNs(r.namespace || r.identity);
            return ns === target;
        })
            .map(cliRecordToEntry);
    }
    catch {
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
/** Finds a monad by name/id across local kernel entries and CLI records. */
export async function findMonadByNameAsync(nameOrId) {
    const kernelResult = findMonadByName(nameOrId);
    if (kernelResult)
        return kernelResult;
    const q = String(nameOrId || "").trim().toLowerCase();
    try {
        const records = await listMonadRecords();
        const match = records.find((r) => r.name.toLowerCase() === q);
        if (match)
            return cliRecordToEntry(match);
    }
    catch { }
    return undefined;
}
/** Lists local-kernel entries plus all CLI-known monads, deduped by endpoint. */
export async function listMonadIndexAsync() {
    const kernelEntries = listMonadIndex();
    let cliEntries = [];
    try {
        const records = await listMonadRecords();
        cliEntries = records.map(cliRecordToEntry);
    }
    catch { }
    const seenEndpoints = new Set(kernelEntries.map((e) => normalizeNs(e.endpoint)));
    const merged = [
        ...kernelEntries,
        ...cliEntries.filter((e) => !seenEndpoints.has(normalizeNs(e.endpoint))),
    ];
    return merged.sort(byRecency);
}
