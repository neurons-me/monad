import type { MonadIndexEntry } from "./monadIndex.js";
export type ClaimMeta = Record<string, unknown>;
export type ScoringMode = "normalized" | "raw";
export type ScoringContext = {
    namespace: string;
    requestedAt: number;
    pathPrefix?: string;
    mode?: ScoringMode;
};
export type Scorer = {
    name: string;
    defaultWeight: number;
    fn: (m: MonadIndexEntry, meta: ClaimMeta, ctx: ScoringContext) => number;
};
export declare function readClaimMeta(monadId: string, namespace: string): ClaimMeta;
export declare function writeClaimMeta(monadId: string, namespace: string, patch: ClaimMeta): void;
export declare function recordForwardResult(monadId: string, namespace: string, elapsedMs: number, ok: boolean): void;
export declare function computeScore(m: MonadIndexEntry, meta: ClaimMeta, ctx: ScoringContext, extraScorers?: Scorer[]): number;
