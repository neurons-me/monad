export type NamespaceClaimProof = {
    message: string;
    signature: string;
    publicKey: string;
    timestamp?: number | null;
};
export type NamespaceClaimInput = {
    namespace: string;
    secret: string;
    identityHash?: string;
    publicKey?: string | null;
    privateKey?: string | null;
    proof?: NamespaceClaimProof | null;
};
export type NamespaceOpenInput = {
    namespace: string;
    secret: string;
    identityHash: string;
};
export type ClaimRecord = {
    namespace: string;
    identityHash: string;
    secretCommitment: string;
    encryptedNoise: string;
    publicKey?: string | null;
    createdAt: number;
    updatedAt: number;
};
export type PersistentClaimKeySource = "provided" | "generated" | "stored";
export type PersistentClaimPublicKey = {
    kid: string;
    alg: string;
    key: string;
    source: PersistentClaimKeySource;
};
export type PersistentClaimSignature = {
    alg: string;
    value: string;
    encoding: "base64";
};
export type PersistentClaimRecord = {
    kind: "PersistentClaimV1";
    version: 1;
    namespace: string;
    identityHash: string;
    publicKey: PersistentClaimPublicKey;
    proofKey: PersistentClaimPublicKey;
    issuedAt: number;
    signature: PersistentClaimSignature;
};
export type PersistentClaimSummary = {
    claimPath: string;
    claim: PersistentClaimRecord;
};
export type ClaimNamespaceResult = {
    ok: true;
    record: ClaimRecord;
    noise: string;
    persistentClaim: PersistentClaimSummary;
} | {
    ok: false;
    error: "NAMESPACE_REQUIRED" | "SECRET_REQUIRED" | "IDENTITY_HASH_REQUIRED" | "NAMESPACE_TAKEN" | "CLAIM_KEY_INVALID" | "CLAIM_KEYPAIR_MISMATCH" | "PROOF_INVALID" | "PROOF_MESSAGE_INVALID" | "PROOF_NAMESPACE_MISMATCH" | "PROOF_TIMESTAMP_INVALID" | "CLAIM_PERSIST_FAILED";
};
export type OpenNamespaceResult = {
    ok: true;
    record: ClaimRecord;
    noise: string;
} | {
    ok: false;
    error: "NAMESPACE_REQUIRED" | "SECRET_REQUIRED" | "IDENTITY_HASH_REQUIRED" | "CLAIM_NOT_FOUND" | "IDENTITY_MISMATCH" | "CLAIM_VERIFICATION_FAILED" | "NOISE_DECRYPT_FAILED";
};
