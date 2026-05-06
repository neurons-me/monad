import type { SelfSurfaceTrust, SelfSurfaceType } from "../http/selfMapping.js";
import type { MonadRuntimeConfig } from "../bootstrap.js";
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
/**
 * Writes or replaces a monad index entry in the local `.me` kernel.
 *
 * The index is the fast structural layer: it answers "who could serve this
 * namespace?" before the scoring engine decides "who should serve it?"
 */
export declare function writeMonadIndexEntry(entry: MonadIndexEntry, persist?: boolean): void;
/** Reads a single local-kernel monad index entry by stable monad id. */
export declare function readMonadIndexEntry(monadId: string): MonadIndexEntry | undefined;
/**
 * Lists local-kernel index entries ordered by freshness.
 *
 * This does not include the CLI record store; use `listMonadIndexAsync` when
 * discovering sibling monads running in other processes on the same machine.
 */
export declare function listMonadIndex(): MonadIndexEntry[];
/**
 * Seeds the current process into the local monad index.
 *
 * Host-like tags are projected into `claimed_namespaces`, while all tags remain
 * available for selector constraints.
 */
export declare function seedSelfMonadIndexEntry(config: MonadRuntimeConfig): void;
/** Updates the local heartbeat timestamp for this monad. */
export declare function touchSelfMonadLastSeen(monadId: string): void;
/**
 * Finds local-kernel monads that claim a namespace.
 *
 * Results are ordered by `last_seen`, with deterministic name/id tie-breaking.
 */
export declare function findMonadsForNamespace(targetNs: string): MonadIndexEntry[];
/** Finds a local-kernel monad by human name or full monad id. */
export declare function findMonadByName(nameOrId: string): MonadIndexEntry | undefined;
/**
 * Adds namespaces to a monad's claimed set.
 *
 * This is the compatibility/fast-index layer. Rich per-namespace metadata lives
 * in `_.mesh.monads.<id>.claimed.<namespace>` and is read by the scoring engine.
 */
export declare function announceClaimedNamespaces(monadId: string, namespaces: string[]): void;
/**
 * Finds namespace claimants across the local kernel and CLI record store.
 *
 * This is the bridge-facing discovery function. It sees sibling monad processes
 * because the CLI `monad.json` records are shared across processes.
 */
export declare function findMonadsForNamespaceAsync(targetNs: string): Promise<MonadIndexEntry[]>;
/** Finds a monad by name/id across local kernel entries and CLI records. */
export declare function findMonadByNameAsync(nameOrId: string): Promise<MonadIndexEntry | undefined>;
/** Lists local-kernel entries plus all CLI-known monads, deduped by endpoint. */
export declare function listMonadIndexAsync(): Promise<MonadIndexEntry[]>;
