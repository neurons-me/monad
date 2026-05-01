import type { Memory } from "this.me";
import { type SemanticMemoryRow } from "./memoryStore.js";
export type ReplayMemory = Memory;
type RecordMemoryInput = {
    namespace: string;
    payload: unknown;
    identityHash?: string | null;
    timestamp?: number;
};
type NamespaceWriteAuthInput = {
    claimIdentityHash: string;
    claimPublicKey?: string | null;
    body: unknown;
};
export declare function recordMemory(input: RecordMemoryInput): SemanticMemoryRow | null;
export declare function getMemoriesForNamespace(namespace: string): ReplayMemory[];
export declare function isNamespaceWriteAuthorized(input: NamespaceWriteAuthInput): boolean;
export {};
