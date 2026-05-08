import type express from "express";
import { type ObserverRelation } from "../http/namespace.js";
export type BridgeTarget = {
    namespace: string;
    selector: string;
    pathSlash: string;
    pathDot: string;
    nrp: string;
    /** Extracted monad name from `monad[frank]` path syntax. */
    monadId?: string | null;
    /** Remaining path after `monad[frank]/` — the path to proxy to the selected monad. */
    monadScopePath?: string | null;
};
export type NamespaceSelectorInfo = {
    base: string;
    selectorRaw: string | null;
    webTarget: string | null;
    hasDevice: boolean;
};
export declare function extractNamespaceSelector(namespace: string): {
    base: string;
    selectorRaw: string | null;
};
export declare function findSelectorValue(selectorRaw: string, selectorType: string): string | null;
export declare function normalizeWebUrl(value: string): string | null;
export declare function getNamespaceSelectorInfo(namespace: string): NamespaceSelectorInfo;
/**
 * Detects `monad[frank]` at the start of a path segment and extracts the monad
 * name plus any remaining path. Returns null when the pattern is absent.
 */
export declare function extractMonadFromPath(pathSlash: string): {
    monadId: string;
    remainingPath: string;
} | null;
export declare function parseBridgeTarget(rawInput: string): BridgeTarget | null;
export declare function buildBridgeTarget(resolved: BridgeTarget | null, requestHost: string, relation: ObserverRelation, rawFallback?: string): {
    namespace: {
        me: string;
        host: string;
    };
    operation: "read";
    path: string;
    nrp: string;
    relation: ObserverRelation;
};
export declare function buildNormalizedTarget(req: express.Request, namespace: string, operation: "read" | "write" | "claim" | "open", path: string): {
    host: string;
    namespace: string;
    operation: "claim" | "write" | "open" | "read";
    path: string;
    nrp: string;
    relation: ObserverRelation;
};
export declare function buildKernelCommandTarget(req: express.Request, operation: "claim" | "open", path: string): {
    host: string;
    namespace: string;
    operation: "claim" | "open";
    path: string;
    nrp: string;
    relation: ObserverRelation;
};
