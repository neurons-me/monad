import crypto from "crypto";
import { normalizeProofMessage, verifyEd25519Signature } from "this.me";
import { getKernel, getRootNamespace } from "../kernel/manager.js";
import { saveSnapshot } from "../kernel/manager.js";
import { buildPersistentClaimBundle, writePersistentClaimBundle } from "./manager.js";
import { hasReservedHandleLabel, normalizeNamespaceIdentity, normalizeNamespaceRootName, parseNamespaceIdentityParts } from "../namespace/identity.js";
import { appendSemanticMemory } from "./memoryStore.js";
import type {
  ClaimNamespaceResult,
  ClaimRecord,
  NamespaceClaimProof,
  NamespaceClaimInput,
  NamespaceOpenInput,
  OpenNamespaceResult,
  PersistentClaimSummary,
} from "./types.js";

const CLAIM_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

function normalizeNamespace(raw: string) {
  return normalizeNamespaceIdentity(raw);
}

type ClaimProofPayload = {
  identityHash: string;
  expression: string;
  namespace: string;
  rootNamespace: string;
  challenge: string | null;
  timestamp: number;
};

type ClaimIdentityResolutionError =
  | "PROOF_REQUIRED"
  | "PROOF_INVALID"
  | "PROOF_MESSAGE_INVALID"
  | "PROOF_NAMESPACE_MISMATCH"
  | "PROOF_TIMESTAMP_INVALID";

// Encode namespace for use as a kernel path segment (dots → __)
function nsKey(namespace: string): string {
  return namespace.replace(/\./g, "__");
}

function claimPath(namespace: string): string {
  return `daemon.claims.${nsKey(namespace)}`;
}

// Navigate proxy chain by dot-path and return the leaf proxy
function nav(root: any, path: string): any {
  return path.split(".").reduce((proxy, key) => proxy[key], root);
}

function kernelGet(path: string): ClaimRecord | undefined {
  const kernelRead = getKernel() as unknown as (rawPath: string) => unknown;
  const result = kernelRead(path);
  return result === undefined || result === null ? undefined : (result as ClaimRecord);
}

function kernelSet(path: string, value: unknown): void {
  nav(getKernel(), path)(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseClaimProofPayload(proof: NamespaceClaimProof): ClaimProofPayload | null {
  const rawMessage = String(proof.message || "");
  if (!rawMessage) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  const canonical = normalizeProofMessage(parsed);
  if (canonical !== rawMessage) return null;

  const identityHash = String(parsed.identityHash || "").trim();
  const expression = String(parsed.expression || "").trim();
  const namespace = normalizeNamespace(String(parsed.namespace || ""));
  const rootNamespace = normalizeNamespaceRootName(String(parsed.rootNamespace || ""));
  const challenge = parsed.challenge == null ? null : String(parsed.challenge);
  const timestamp = Number(parsed.timestamp || 0);

  if (!identityHash || !expression || !namespace || !rootNamespace || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return {
    identityHash,
    expression,
    namespace,
    rootNamespace,
    challenge,
    timestamp,
  };
}

function normalizeProofTimestamp(proof: NamespaceClaimProof, payload: ClaimProofPayload): number {
  const direct = Number(proof.timestamp ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return payload.timestamp;
}

function enforceClaimProofWindow(timestamp: number): boolean {
  return Math.abs(Date.now() - timestamp) <= CLAIM_PROOF_MAX_AGE_MS;
}

function rawEd25519PublicKeyToPem(rawPublicKey: string): string {
  const raw = Buffer.from(String(rawPublicKey || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(rawPublicKey || "").length / 4) * 4, "="), "base64");
  if (raw.length !== 32) {
    throw new Error("PROOF_INVALID");
  }
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, raw]);
  const publicKey = crypto.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki",
  });
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

async function resolveClaimIdentity(input: NamespaceClaimInput): Promise<
  | { ok: true; identityHash: string; publicKeyPem: string | null }
  | { ok: false; error: ClaimIdentityResolutionError }
> {
  // A first claim without a proof used to trust input.identityHash as
  // asserted — but identityHash is a PUBLIC fingerprint (shown in the UI,
  // meant to be shared), so anyone could claim a namespace under someone
  // else's identityHash with zero cryptographic check. Every real caller
  // (cleaker's bindKernel, via me['!'].prove()) already sends a proof —
  // this is now mandatory, not merely verified-when-present. openNamespace()
  // is unaffected: re-opening an already-claimed namespace is gated by
  // secretCommitment, not identityHash, and never reaches this function.
  const proof = input.proof;
  if (!proof) {
    return { ok: false, error: "PROOF_REQUIRED" };
  }

  const payload = parseClaimProofPayload(proof);
  if (!payload) return { ok: false, error: "PROOF_MESSAGE_INVALID" };
  if (payload.namespace !== normalizeNamespace(input.namespace)) {
    return { ok: false, error: "PROOF_NAMESPACE_MISMATCH" };
  }

  const proofTimestamp = normalizeProofTimestamp(proof, payload);
  if (!enforceClaimProofWindow(proofTimestamp)) {
    return { ok: false, error: "PROOF_TIMESTAMP_INVALID" };
  }

  const verified = await verifyEd25519Signature(
    String(proof.publicKey || ""),
    proof.message,
    String(proof.signature || ""),
  );
  if (!verified) return { ok: false, error: "PROOF_INVALID" };

  try {
    return {
      ok: true,
      identityHash: payload.identityHash,
      publicKeyPem: rawEd25519PublicKeyToPem(String(proof.publicKey || "")),
    };
  } catch {
    return { ok: false, error: "PROOF_INVALID" };
  }
}

function materializeProjectedNamespaceClaim(namespace: string, _timestamp: number) {
  const identity = parseNamespaceIdentityParts(namespace);
  const hostNamespace = normalizeNamespaceRootName(identity.host);
  const username = String(identity.username || "").trim().toLowerCase();

  if (!hostNamespace || !username) return;

  kernelSet(`daemon.users.${nsKey(hostNamespace)}.${username}`, { __ptr: namespace });
  appendSemanticMemory({
    namespace: hostNamespace,
    path: `users.${username}`,
    operator: "__",
    data: { __ptr: namespace },
    timestamp: _timestamp,
  });
}

export function rebuildProjectedNamespaceClaims(): number {
  // Kernel state is always consistent — no rebuild needed
  return 0;
}

export function getClaim(namespace: string): ClaimRecord | undefined {
  const ns = normalizeNamespace(namespace);
  if (!ns) return undefined;
  return kernelGet(claimPath(ns));
}

export async function claimNamespace(input: NamespaceClaimInput): Promise<ClaimNamespaceResult> {
  const namespace = normalizeNamespace(input.namespace);
  const resolved = await resolveClaimIdentity(input);
  const identityHash = resolved.ok ? resolved.identityHash : "";
  // input.publicKey is a distinct, optional concept from the proof's own
  // signing key: it's the NAMESPACE's own long-lived key (hardware key,
  // external PKI, cross-device identity — see persistentClaim.test.ts),
  // separate from the proof's ephemeral branch-signing key that only
  // establishes identityHash. An explicit one always wins; the proof's key
  // is just the fallback when the caller supplied none.
  const publicKey = String(input.publicKey || "").trim() || (resolved.ok ? resolved.publicKeyPem : null);
  const privateKey = String(input.privateKey || "").trim() || null;

  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };
  // www.<root> is the root's own front door and api.<root> its service address:
  // never a person's handle, so never claimable as one -- whoever asks.
  if (hasReservedHandleLabel(namespace)) return { ok: false, error: "RESERVED_HANDLE" };
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const exists = getClaim(namespace);
  if (exists) return { ok: false, error: "NAMESPACE_TAKEN" };

  const now = Date.now();
  let persistentClaim: PersistentClaimSummary;

  try {
    const bundle = buildPersistentClaimBundle({
      namespace,
      identityHash,
      publicKey,
      privateKey,
      issuedAt: now,
    });

    const record: ClaimRecord = {
      namespace,
      identityHash,
      publicKey: bundle.summary.claim.publicKey.key,
      createdAt: now,
      updatedAt: now,
    };

    kernelSet(claimPath(namespace), record);
    persistentClaim = writePersistentClaimBundle(bundle);
    materializeProjectedNamespaceClaim(namespace, now);
    saveSnapshot();
  } catch (error) {
    try { kernelSet(claimPath(namespace), undefined); } catch { }

    const code = error instanceof Error ? error.message : String(error);
    if (code === "CLAIM_KEYPAIR_MISMATCH") return { ok: false, error: "CLAIM_KEYPAIR_MISMATCH" };
    if (code === "CLAIM_KEY_INVALID") return { ok: false, error: "CLAIM_KEY_INVALID" };
    if (code === "CLAIM_KEY_REQUIRED") return { ok: false, error: "CLAIM_KEY_REQUIRED" };
    return { ok: false, error: "CLAIM_PERSIST_FAILED" };
  }

  const record = getClaim(namespace)!;
  return { ok: true, persistentClaim, record };
}

// Reopening a namespace no longer trusts a shared secret at all -- it is
// authorized exactly the way a write is: a real Ed25519 signature, verified
// against the claim's own record.publicKey (this.me/prove()'s own signing
// key, the same key every write already gets checked against). Two things
// this closes that a shared secret never could: (1) possessing the
// password already means possessing the signing key (deriveCompoundSeed is
// the SAME one-way function feeding both) -- a second, independent
// "recovery secret" sent over the wire on every open added a leak with no
// corresponding security gain; (2) a recovery-phrase-derived identity
// signs with the SAME recovered key it always would, so recovery is
// unaffected by removing the secret path.
//
// The proof is the SAME shape claimNamespace() already verifies
// (ClaimProof: message/signature/publicKey/timestamp, parsed by
// parseClaimProofPayload into {identityHash, expression, namespace,
// rootNamespace, challenge, timestamp}) -- produced by calling this.me's
// own prove() a second time, the exact way cleaker's proveKernelNamespace()
// already does for claim, just with a real per-open nonce as `challenge`
// instead of claim's hardcoded null. Reusing this shape (rather than a
// bespoke {op, namespace, audience, nonce, timestamp} message, which
// this.me's prove() has no way to produce -- its message shape is fixed)
// means no new low-level signing code is needed anywhere this is called
// from. Two of its existing fields do the job review's design asked for
// under different names:
//   - `rootNamespace` IS the audience binding: checked against THIS
//     process's own getRootNamespace(), never trusted from the payload,
//     so a signature made for one monad can't be replayed against a
//     different one serving the same namespace (e.g. a netget mesh
//     delegate) -- the two would reconstruct a different rootNamespace.
//   - `challenge` carries the anti-replay nonce (claimed via
//     claimOpenNonce below); a genuine claim proof always has
//     challenge: null (proveKernelNamespace's own hardcoded value), so it
//     can never itself be replayed as an open -- NONCE_REQUIRED rejects it.
//
// Short on purpose (open happens on every login, not once like a claim) --
// this is also the nonce store's retention window below, so the exposure
// from a process restart mid-window (the in-memory nonce set is lost on
// restart, so a signed-and-already-used open message could be replayed
// once more before it ages out) stays bounded to roughly this long, not
// indefinitely. Documented here rather than "fixed" because fixing it
// (persisting nonces) trades an already-small, time-boxed window for
// unbounded disk growth -- not a clearly better trade.
const OPEN_CHALLENGE_MAX_AGE_MS = 60 * 1000;

function enforceOpenChallengeWindow(timestamp: number): boolean {
  return Math.abs(Date.now() - timestamp) <= OPEN_CHALLENGE_MAX_AGE_MS;
}

// namespace -> (nonce -> expiresAt). Process-local, in-memory, never
// persisted -- see OPEN_CHALLENGE_MAX_AGE_MS's own comment for why that's
// an accepted, bounded gap rather than a bug. There is no equivalent store
// to reuse from the write path: writes bind to a rotating chain head
// (getNamespaceChainHead in replay.ts), which only works because a write
// actually moves the head: opening a namespace doesn't write anything, so
// the same identical signed message would otherwise verify every time.
const usedOpenNonces = new Map<string, Map<string, number>>();

function pruneExpiredOpenNonces(namespace: string, now: number): void {
  const nonces = usedOpenNonces.get(namespace);
  if (!nonces) return;
  for (const [nonce, expiresAt] of nonces) {
    if (expiresAt <= now) nonces.delete(nonce);
  }
  if (nonces.size === 0) usedOpenNonces.delete(namespace);
}

// Returns false when `nonce` was already used (within its still-live
// window) for `namespace` -- the caller must treat that as a rejected
// replay, not retry or ignore it. Claims the nonce as a side effect only
// when returning true, so a rejected attempt never consumes it.
function claimOpenNonce(namespace: string, nonce: string, timestamp: number): boolean {
  const now = Date.now();
  pruneExpiredOpenNonces(namespace, now);
  let nonces = usedOpenNonces.get(namespace);
  if (nonces?.has(nonce)) return false;
  if (!nonces) {
    nonces = new Map();
    usedOpenNonces.set(namespace, nonces);
  }
  nonces.set(nonce, now + OPEN_CHALLENGE_MAX_AGE_MS);
  return true;
}

/** Test-only: clears the in-memory open-nonce store between test cases/files. */
export function resetOpenNonceStoreForTests(): void {
  usedOpenNonces.clear();
}

export async function openNamespace(input: NamespaceOpenInput): Promise<OpenNamespaceResult> {
  const namespace = normalizeNamespace(input.namespace);
  const proof = input.proof;

  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };
  if (!proof) return { ok: false, error: "PROOF_REQUIRED" };

  const record = getClaim(namespace);
  if (!record) return { ok: false, error: "CLAIM_NOT_FOUND" };
  // A claim persisted before this session's proof-mandatory fix could have
  // no client-held key at all (the server generated and held one on the
  // caller's behalf -- see claim/manager.ts's resolveClaimKeys, and the
  // fallback branches removed there in the same change as this function).
  // Such a namespace cannot be reopened by anyone via a real signature; it
  // was never sovereign in the sense this scheme requires, and re-claiming
  // it is the only way forward, not something this function can paper over.
  if (!record.publicKey) return { ok: false, error: "CLAIM_KEY_UNAVAILABLE" };

  const payload = parseClaimProofPayload(proof);
  if (!payload) return { ok: false, error: "PROOF_MESSAGE_INVALID" };
  if (payload.namespace !== namespace) return { ok: false, error: "PROOF_NAMESPACE_MISMATCH" };
  // Audience binding, see this function's own header comment.
  if (normalizeNamespaceRootName(payload.rootNamespace) !== getRootNamespace()) {
    return { ok: false, error: "PROOF_NAMESPACE_MISMATCH" };
  }

  const proofTimestamp = normalizeProofTimestamp(proof, payload);
  if (!enforceOpenChallengeWindow(proofTimestamp)) return { ok: false, error: "PROOF_TIMESTAMP_INVALID" };

  // Domain-separated, not just "any non-null challenge" -- a claim proof's
  // own challenge is NOT reliably null. useCleakerAuth.ts's sign-up flow
  // (the real production /claims caller) signs a real, non-null challenge
  // of its own (a canonicalJson string binding the claim to its
  // destination) -- proveKernelNamespace()'s hardcoded null is only true
  // for cleaker's OWN claimRemote() path, not every caller. Without this
  // prefix, a captured claim proof from that flow would verify as a valid
  // OPEN too (identical message shape, identical verification pipeline,
  // and its own challenge string trivially satisfies "looks like an unused
  // nonce") within the 60s window -- and open() hands back real memories,
  // which a claim's own response never does. The prefix is the whole fix:
  // every OPEN_NONCE_PREFIX is a distinct wire convention this function
  // alone recognizes, so nothing signed for a different purpose (a claim,
  // a future third use of prove()) can satisfy it by coincidence.
  const OPEN_NONCE_PREFIX = "open:";
  const rawChallenge = String(payload.challenge || "").trim();
  if (!rawChallenge.startsWith(OPEN_NONCE_PREFIX)) return { ok: false, error: "NONCE_REQUIRED" };
  const nonce = rawChallenge.slice(OPEN_NONCE_PREFIX.length);
  if (!nonce) return { ok: false, error: "NONCE_REQUIRED" };
  if (!claimOpenNonce(namespace, nonce, proofTimestamp)) return { ok: false, error: "NONCE_REUSED" };

  const verified = await verifyEd25519Signature(String(proof.publicKey || ""), proof.message, String(proof.signature || ""));
  if (!verified) return { ok: false, error: "CLAIM_VERIFICATION_FAILED" };

  let provenPem: string;
  try {
    provenPem = rawEd25519PublicKeyToPem(String(proof.publicKey || ""));
  } catch {
    return { ok: false, error: "CLAIM_VERIFICATION_FAILED" };
  }
  // The proof is a genuinely valid signature -- but from WHOSE key? Must be
  // the exact key this namespace's claim recorded, not merely "a" valid key.
  if (provenPem !== record.publicKey) return { ok: false, error: "CLAIM_VERIFICATION_FAILED" };

  return { ok: true, record };
}
