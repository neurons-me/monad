export type LedgerBlockRow = {
    memoryHash: string;
    prevMemoryHash: string;
    timestamp: number;
    namespace: string;
    path: string;
    operator: string | null;
    value: unknown;
    authorIdentityHash?: string;
    authorPublicKey?: string;
    signature?: string | null;
};
export declare function getAllBlocks(): LedgerBlockRow[];
export declare function getBlocksForIdentity(identityHash: string): LedgerBlockRow[];
export declare function getBlocksForNamespace(namespace: string): LedgerBlockRow[];
