import type express from "express";
export type ObserverRelationMode = "raw" | "self" | "observer" | "view";
export interface ObserverRelation {
    operator: "?";
    mode: ObserverRelationMode;
    value: string | null;
    observer: string | null;
    namespace: string | null;
}
export declare function createRawObserverRelation(): ObserverRelation;
export declare function resolveHostNamespace(req: express.Request): string;
export declare function resolveTransportHost(req: express.Request): string;
export declare function isReservedLabel(label: string): boolean;
export declare function isProjectableRootHost(hostname: string): boolean;
export declare function normalizeUsernameLabel(raw: string): string;
export declare function canonicalPair(a: string, b: string): string;
export declare function getAtSelectorFromPath(req: express.Request): {
    kind: "relation";
    pair: string;
    username?: undefined;
} | {
    kind: "user";
    username: string;
    pair?: undefined;
} | null;
export declare function getAtNestedUserFromPath(req: express.Request): {
    a: string;
    b: string;
} | null;
export declare function resolveChainNamespace(req: express.Request): string;
export declare function resolveNamespace(req: express.Request): string;
export declare function resolveNamespaceProjectionRoot(namespace: string): string;
export declare function resolveObserverRelation(req: express.Request): ObserverRelation;
export declare function formatObserverRelationLabel(relation: ObserverRelation): string;
export declare function formatObserverRelationQuery(relation: ObserverRelation): string;
export declare function resolveLens(req: express.Request): string;
export declare function filterBlocksByNamespace(allBlocks: any[], ns: string): any[];
