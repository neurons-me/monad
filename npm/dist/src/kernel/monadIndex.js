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
export function writeMonadIndexEntry(entry, persist = false) {
    nav(getKernel(), `${INDEX_ROOT}.${monadKey(entry.monad_id)}`)(entry);
    if (persist)
        saveSnapshot();
}
export function readMonadIndexEntry(monadId) {
    const kernelRead = getKernel();
    const result = kernelRead(`${INDEX_ROOT}.${monadKey(monadId)}`);
    return result !== null && result !== undefined && typeof result === "object"
        ? result
        : undefined;
}
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
    return [...latest.values()].filter((v) => v !== null);
}
export function seedSelfMonadIndexEntry(config) {
    const self = config.selfNodeConfig;
    if (!self?.monadId)
        return;
    const now = Date.now();
    const existing = readMonadIndexEntry(self.monadId);
    writeMonadIndexEntry({
        monad_id: self.monadId,
        namespace: self.identity,
        endpoint: self.endpoint,
        name: self.monadName,
        type: self.type,
        trust: self.trust,
        public_key: self.publicKey,
        first_seen: existing?.first_seen ?? now,
        last_seen: now,
    }, true);
}
export function touchSelfMonadLastSeen(monadId) {
    const existing = readMonadIndexEntry(monadId);
    if (!existing)
        return;
    writeMonadIndexEntry({ ...existing, last_seen: Date.now() });
}
