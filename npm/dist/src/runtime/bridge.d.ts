import type express from "express";
import { type ObserverRelation } from "../http/namespace.js";
export type BridgeTarget = {
    namespace: string;
    selector: string;
    pathSlash: string;
    pathDot: string;
    nrp: string;
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
