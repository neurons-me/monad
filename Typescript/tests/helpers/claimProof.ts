// claimProof.ts — builds a real, verifiable claim proof for tests, using
// WebCrypto's native Ed25519 support directly. this.me's own ME.prove()
// derives its signing key deterministically via HKDF from a kernel seed +
// active expression — but that derivation helper (importEd25519SigningKey)
// isn't part of this.me's public export surface (only normalizeProofMessage
// and verifyEd25519Signature are, matching what records.ts imports), and
// this.me@3.9.1 (the version pinned here) doesn't yet publish the
// 2-arg ME(who, secret) form or prove() itself either — workspace-local
// additions not yet released. Tests don't need the SAME derivation, only a
// genuinely valid Ed25519 signature over the canonical message: any
// keypair verifies the same way records.ts's resolveClaimIdentity() checks
// it (WebCrypto subtle.verify with the raw public key), so a freshly
// generated one is a real proof, not a stub.
import { normalizeProofMessage } from "this.me";
import type { NamespaceClaimProof } from "../../src/claim/types";

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function buildClaimProof(options: {
  namespace: string;
  identityHash: string;
  expression?: string;
  rootNamespace?: string;
  challenge?: string | null;
  timestamp?: number;
}): Promise<NamespaceClaimProof> {
  const expression = options.expression || "test-expression";
  const rootNamespace = options.rootNamespace || "cleaker.me";
  const challenge = options.challenge ?? null;
  const timestamp = options.timestamp ?? Date.now();

  const subtle = globalThis.crypto.subtle;
  const { privateKey, publicKey } = await subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKeyRaw = toBase64Url(await subtle.exportKey("raw", publicKey));

  const payload = {
    identityHash: options.identityHash,
    expression,
    namespace: options.namespace,
    rootNamespace,
    challenge,
    timestamp,
  };
  const message = normalizeProofMessage(payload);
  const signatureBuf = await subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(message),
  );
  const signature = toBase64Url(signatureBuf);

  return { message, signature, publicKey: publicKeyRaw, timestamp };
}
