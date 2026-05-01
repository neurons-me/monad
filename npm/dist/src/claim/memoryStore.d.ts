export interface SemanticMemoryRow {
    id: number;
    namespace: string;
    path: string;
    operator: string | null;
    data: unknown;
    hash: string;
    prevHash: string;
    signature: string | null;
    timestamp: number;
}
export interface HostMemoryHistoryRow extends SemanticMemoryRow {
    namespace: string;
    username: string;
    fingerprint: string;
    host_key: string;
}
export interface AuthorizedHostRow {
    id: string;
    namespace: string;
    username: string;
    host_key: string;
    fingerprint: string;
    public_key: string;
    hostname: string;
    label: string;
    local_endpoint: string;
    attestation: string;
    capabilities_json: string;
    status: "authorized" | "revoked";
    created_at: number;
    last_used: number;
    revoked_at: number | null;
}
export declare function createSessionNonce(usernameInput: string, ttlMs?: number): {
    username: string;
    nonce: string;
    iat: number;
    exp: number;
};
export declare function consumeSessionNonce(usernameInput: string, nonceInput: string): boolean;
export declare function appendSemanticMemory(input: {
    namespace: string;
    path: string;
    operator?: string | null;
    data: unknown;
    signature?: string | null;
    expectedPrevHash?: string;
    timestamp?: number;
}): SemanticMemoryRow;
export declare function listSemanticMemoriesByNamespace(namespaceInput: string, options?: {
    prefix?: string;
    limit?: number;
}): SemanticMemoryRow[];
export declare function listSemanticMemoriesByNamespaceBranch(namespaceInput: string, branchPathInput: string, options?: {
    limit?: number;
}): SemanticMemoryRow[];
export declare function buildSemanticTreeForNamespace(namespaceInput: string, options?: {
    prefix?: string;
    limit?: number;
}): Record<string, unknown>;
export declare function buildSemanticBranchTreeForNamespace(namespaceInput: string, branchPathInput: string, options?: {
    limit?: number;
}): Record<string, unknown>;
export declare function readSemanticBranchForNamespace(namespaceInput: string, pathInput: string): unknown;
export declare function readSemanticValueForNamespace(namespaceInput: string, pathInput: string): unknown;
export declare function listSemanticMemoriesByRootNamespace(rootNamespaceInput: string, options?: {
    limit?: number;
}): SemanticMemoryRow[];
export declare function listHostsByNamespace(namespaceInput: string, usernameInput: string): AuthorizedHostRow[];
export declare function listHostsByUsername(usernameInput: string): AuthorizedHostRow[];
export declare function getHostStatus(namespaceInput: string, usernameInput: string, fingerprintInput: string): "authorized" | "revoked" | null;
export declare function listHostMemoryHistory(namespaceInput: string, usernameInput: string, fingerprintInput: string, limitInput?: number): HostMemoryHistoryRow[];
export declare function rebuildAuthorizedHostsProjection(_usernameInput?: string): number;
