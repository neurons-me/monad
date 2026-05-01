import type { BridgeTarget } from "./bridge.js";
export type ClaimIdentity = {
    host: string;
    username: string;
    effective: string;
};
export declare function normalizeOperation(input: unknown): "read" | "write" | "claim" | "open";
export declare function normalizeClaimableNamespace(raw: unknown): string;
export declare function isCanonicalClaimableNamespace(namespace: string): boolean;
export declare function resolveCommandNamespace(operation: "read" | "write" | "claim" | "open", body: Record<string, unknown>, parsedTarget: BridgeTarget | null, fallbackNamespace: string): string;
export declare function getDefaultReadPolicy(namespace: string): {
    allowed: string[];
    capabilities: string[];
};
export declare function parseNamespaceIdentity(namespace: string): ClaimIdentity;
