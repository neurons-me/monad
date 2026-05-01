import type { PersistentClaimSummary } from "./types.js";
type BuiltClaimBundle = {
    summary: PersistentClaimSummary;
    privateKeyPath: string | null;
    privateKeyPem: string | null;
    persistPrivateKey: boolean;
};
export declare function getPersistentClaimPath(namespace: string): string;
export declare function buildPersistentClaimBundle(input: {
    namespace: string;
    identityHash: string;
    publicKey?: string | null;
    privateKey?: string | null;
    issuedAt?: number;
}): BuiltClaimBundle;
export declare function writePersistentClaimBundle(bundle: BuiltClaimBundle): PersistentClaimSummary;
export declare function loadPersistentClaim(namespace: string): PersistentClaimSummary | null;
export declare function verifyPersistentClaim(namespace: string): boolean;
export declare function deletePersistentClaim(namespace: string): void;
export {};
