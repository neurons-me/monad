import type { ClaimNamespaceResult, ClaimRecord, NamespaceClaimInput, NamespaceOpenInput, OpenNamespaceResult } from "./types.js";
export declare function rebuildProjectedNamespaceClaims(): number;
export declare function getClaim(namespace: string): ClaimRecord | undefined;
export declare function claimNamespace(input: NamespaceClaimInput): Promise<ClaimNamespaceResult>;
export declare function openNamespace(input: NamespaceOpenInput): OpenNamespaceResult;
