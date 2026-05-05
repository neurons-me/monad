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
    first_seen: number;
    last_seen: number;
    version?: string;
    capabilities?: string[];
}
export declare function writeMonadIndexEntry(entry: MonadIndexEntry, persist?: boolean): void;
export declare function readMonadIndexEntry(monadId: string): MonadIndexEntry | undefined;
export declare function listMonadIndex(): MonadIndexEntry[];
export declare function seedSelfMonadIndexEntry(config: MonadRuntimeConfig): void;
export declare function touchSelfMonadLastSeen(monadId: string): void;
