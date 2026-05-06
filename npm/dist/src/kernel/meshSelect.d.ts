import { type MonadIndexEntry } from "./monadIndex.js";
import { type Scorer } from "./scoring.js";
export declare const DEFAULT_STALE_MS = 300000;
export type MeshSelection = {
    entry: MonadIndexEntry;
    reason: "name-selector" | "mesh-claim";
};
export declare function matchesMeshSelector(entry: MonadIndexEntry, selectorRaw: string | null): boolean;
export declare function selectMeshClaimant(opts: {
    monadSelector: string;
    namespace: string;
    selfEndpoint: string;
    selfMonadId: string;
    selectorConstraint?: string | null;
    stalenessMs?: number;
    now?: number;
    extraScorers?: Scorer[];
}): Promise<MeshSelection | null>;
