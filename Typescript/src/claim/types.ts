export type NamespaceClaimProof = {
  message: string;
  signature: string;
  publicKey: string;
  timestamp?: number | null;
};

export type NamespaceClaimInput = {
  namespace: string;
  identityHash?: string;
  publicKey?: string | null;
  privateKey?: string | null;
  proof?: NamespaceClaimProof | null;
};

// { namespace, proof }: proof is a real this.me ClaimProof (the same shape
// claimNamespace() verifies), produced by calling prove() a second time
// with a real nonce as `challenge` instead of claim's hardcoded null. See
// records.ts's openNamespace() for why this shape is reused instead of a
// bespoke one, and how its rootNamespace/challenge fields double as the
// audience binding and anti-replay nonce.
export type NamespaceOpenInput = {
  namespace: string;
  proof?: NamespaceClaimProof | null;
};

export type ClaimRecord = {
  namespace: string;
  identityHash: string;
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

export type ClaimNamespaceResult =
  | { ok: true; record: ClaimRecord; persistentClaim: PersistentClaimSummary }
  | {
      ok: false;
      error:
        | "NAMESPACE_REQUIRED"
        | "PROOF_REQUIRED"
        | "NAMESPACE_TAKEN"
        | "RESERVED_HANDLE"
        | "CLAIM_KEY_INVALID"
        | "CLAIM_KEYPAIR_MISMATCH"
        | "CLAIM_KEY_REQUIRED"
        | "PROOF_INVALID"
        | "PROOF_MESSAGE_INVALID"
        | "PROOF_NAMESPACE_MISMATCH"
        | "PROOF_TIMESTAMP_INVALID"
        | "CLAIM_PERSIST_FAILED";
    };

export type OpenNamespaceResult =
  | { ok: true; record: ClaimRecord }
  | {
      ok: false;
      error:
        | "NAMESPACE_REQUIRED"
        | "PROOF_REQUIRED"
        | "PROOF_MESSAGE_INVALID"
        | "PROOF_NAMESPACE_MISMATCH"
        | "PROOF_TIMESTAMP_INVALID"
        | "NONCE_REQUIRED"
        | "NONCE_REUSED"
        | "CLAIM_NOT_FOUND"
        | "CLAIM_KEY_UNAVAILABLE"
        | "CLAIM_VERIFICATION_FAILED";
    };
