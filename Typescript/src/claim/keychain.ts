/**
 * keychain.ts — real, minimal per-identity keychain: more than one
 * authorizable, revocable signing key per namespace, instead of the single
 * fixed claim key `records.ts`'s ClaimRecord assumes.
 *
 * Bootstrap answer: a namespace's existing claim (`getClaim`, populated
 * when the recoverable identity first claims its own namespace) is the
 * trust anchor for the FIRST keychain key. It stays a standing anchor,
 * never a one-shot: a recovery phrase that only worked once would recover
 * the identity but not control of the keychain, which defeats the entire
 * point of a BIP-39 recovery phrase (a device holding the only delegated
 * key can always be lost). So the claim key can ALSO invoke
 * recoverKeychainWithRoot() at any time, not just when the keychain is
 * empty -- but that is a distinct, explicit operation from ordinary
 * peer-signed registerKeychainKey(), not a silent fallback: it revokes
 * every currently-active key and mints exactly one fresh one, matching
 * "all delegated keys are presumed lost, start over" rather than quietly
 * adding a key alongside ones that may still be fine. Ordinary, day-to-day
 * registration/revocation after the first key still goes entirely through
 * already-active ADMIN keychain keys -- the claim key is not asked again
 * for routine operations. The claim/root key itself is NEVER inserted into
 * the registry as a KeychainKeyRecord; it is always an external
 * authorizer, never an entry.
 *
 * What a key IS authorized for, on purpose, kept narrow: a keychain key is
 * generic Ed25519 material -- nothing about the bits says what it's "for".
 * The only thing this registry tracks is (a) is this specific public key
 * currently active for this identity at all, and (b) can it administer
 * THIS keychain (add/revoke other keys) -- because the keychain is the
 * system actually consuming that second fact when it processes a
 * register/revoke request. Whether some OTHER system (netget accepting a
 * gateway claim, a generic namespace write) should trust a signature from
 * an active key is that other system's own decision, checked against ITS
 * OWN authorization model (e.g. GatewayClaimsManager's existing
 * identityHash-keyed grants) -- never something this registry pre-declares
 * or gates. A signature only proves possession of the private key; what
 * that's worth is entirely up to whoever asked for it.
 *
 * Every signed body below carries a small `op` discriminator so a
 * signature valid for one keychain operation (register vs. revoke vs.
 * sign vs. recover) can never be replayed as a different one, even when
 * the rest of the fields happen to coincide.
 *
 * Every mutation's signature is verified with isNamespaceWriteAuthorized()
 * (replay.ts) — the same anti-"sign A, send B" canonicalization every
 * other real write path in this codebase (POST /, /api/v1/commit) already
 * relies on. That function only needs {identityHash-shaped string,
 * PEM public key, body} — it doesn't care whether the "identity" behind
 * the check is a namespace claim or a keychain key, so it's reused as-is
 * for both the bootstrap check (against the claim) and every later check
 * (against an acting keychain key).
 */

import crypto from "crypto";
import { getClaim } from "./records.js";
import { isNamespaceWriteAuthorized } from "./replay.js";
import {
  appendSemanticMemory,
  readSemanticBranchForNamespace,
  readSemanticValueForNamespace,
} from "./memoryStore.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";
import { saveSnapshot } from "../kernel/manager.js";

export interface KeychainKeyRecord {
  keyId: string;
  label: string;
  publicKey: string; // SPKI PEM, so isNamespaceWriteAuthorized's crypto.createPublicKey() accepts it directly
  /** Can this key administer THIS keychain (register/revoke other keys)?
   *  The only privilege the keychain itself has an opinion about. */
  admin: boolean;
  authorization: "active" | "revoked";
  addedAt: number;
  addedBy: string; // "bootstrap" | "root-recovery" | the actingKeyId that authorized it
  revokedAt?: number;
  revokedBy?: string;
}

export type KeychainError =
  | "NAMESPACE_REQUIRED"
  | "INVALID_PUBLIC_KEY"
  | "CLAIM_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "PROOF_REQUIRED"
  | "PROOF_INVALID"
  | "REPLAY_REJECTED"
  | "ACTING_KEY_REQUIRED"
  | "ACTING_KEY_NOT_FOUND"
  | "ACTING_KEY_REVOKED"
  | "PERMISSION_DENIED"
  | "TARGET_KEY_NOT_FOUND"
  | "CANNOT_REVOKE_LAST_ADMIN"
  | "RESERVED_PATH"
  | "FOREIGN_NAMESPACE_REJECTED";

export type KeychainResult<T> = { ok: true; value: T } | { ok: false; error: KeychainError };

const KEYCHAIN_KEYS_BRANCH = "keychain.keys";
const KEYCHAIN_OPERATIONS_BRANCH = "keychain.operations";

// ─── raw Ed25519 public key -> SPKI PEM ──────────────────────────────────────
// Duplicated from syncHandler.ts's rawEd25519PublicKeyToPem (not exported
// there) rather than imported across a handler/claim layering boundary —
// same fixed SPKI DER prefix for Ed25519 (RFC 8410), same conversion.
function rawEd25519PublicKeyToPem(rawPublicKeyBase64Url: string): string | null {
  try {
    const normalized = String(rawPublicKeyBase64Url || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const raw = Buffer.from(padded, "base64");
    if (raw.length !== 32) return null;
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiPrefix, raw]);
    const key = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function computeKeyId(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 32);
}

// ─── replay cache: reject a (namespace, actorKeyId, nonce) seen before ──────
// isNamespaceWriteAuthorized only proves "this body was signed by this key"
// -- it has no notion of a request being reused. A valid signature over a
// nonce+timestamp is only non-replayable if the server remembers which
// nonces it already accepted for that signer and rejects a repeat, and
// rejects a timestamp too old to plausibly be the original request.
const REPLAY_WINDOW_MS = 120_000;
const _seenNonces = new Map<string, number>(); // `${namespace}:${actorKeyId}:${nonce}` -> expiry

function isFreshTimestamp(timestamp: unknown): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= REPLAY_WINDOW_MS;
}

function nonceReplayKey(namespace: string, actorKeyId: string, nonce: string): string {
  return `${namespace}:${actorKeyId}:${nonce}`;
}

function isNonceReplayed(namespace: string, actorKeyId: string, nonce: string): boolean {
  const key = nonceReplayKey(namespace, actorKeyId, nonce);
  const expiry = _seenNonces.get(key);
  return expiry !== undefined && expiry >= Date.now();
}

function consumeNonce(namespace: string, actorKeyId: string, nonce: string): void {
  const key = nonceReplayKey(namespace, actorKeyId, nonce);
  _seenNonces.set(key, Date.now() + REPLAY_WINDOW_MS);
  // opportunistic cleanup so this map doesn't grow unbounded across a long-lived process
  if (_seenNonces.size > 10_000) {
    const now = Date.now();
    for (const [k, exp] of _seenNonces) if (exp < now) _seenNonces.delete(k);
  }
}

export function resetKeychainNonceCacheForTests(): void {
  _seenNonces.clear();
}

// ─── reserved path guard ────────────────────────────────────────────────
// keychain.* must only ever be mutated through the validated functions in
// this file (correct keyId derivation, admin/vigencia/replay checks,
// last-admin safety). A generic namespace-write path (POST /, POST
// /api/v1/commit) that lets a claimed identity write ANY path under its
// own namespace would otherwise let that same identity silently overwrite
// keychain.* directly -- technically not a privilege escalation (the claim
// already owns that whole namespace), but a real integrity hole: it can
// corrupt the registry's invariants (fabricate an already-"active" admin
// record it was never granted through registerKeychainKey, resurrect a
// revoked key by hand, skip replay/nonce bookkeeping entirely). Generic
// write handlers call this before committing and reject outright if a
// target path falls under this branch.
export function isKeychainReservedPath(pathInput: string): boolean {
  const path = String(pathInput || "").trim();
  return path === "keychain" || path.startsWith("keychain.");
}

// ─── registry reads ───────────────────────────────────────────────────────

export function listKeychainKeys(namespaceInput: string): KeychainKeyRecord[] {
  const namespace = normalizeNamespaceIdentity(namespaceInput);
  if (!namespace) return [];
  const branch = readSemanticBranchForNamespace(namespace, KEYCHAIN_KEYS_BRANCH);
  if (!isPlainRecord(branch)) return [];
  return Object.values(branch).filter(isPlainRecord) as unknown as KeychainKeyRecord[];
}

export function getKeychainKey(namespaceInput: string, keyId: string): KeychainKeyRecord | null {
  const namespace = normalizeNamespaceIdentity(namespaceInput);
  if (!namespace || !keyId) return null;
  const record = readSemanticValueForNamespace(namespace, `${KEYCHAIN_KEYS_BRANCH}.${keyId}`);
  return isPlainRecord(record) ? (record as unknown as KeychainKeyRecord) : null;
}

export function isKeychainBootstrapped(namespaceInput: string): boolean {
  return listKeychainKeys(namespaceInput).some((k) => k.authorization === "active");
}

function activeAdminKeyCount(namespace: string, excludingKeyId?: string): number {
  return listKeychainKeys(namespace).filter(
    (k) => k.authorization === "active" && k.admin && k.keyId !== excludingKeyId,
  ).length;
}

function writeKeyRecord(namespace: string, record: KeychainKeyRecord): void {
  appendSemanticMemory({ namespace, path: `${KEYCHAIN_KEYS_BRANCH}.${record.keyId}`, data: record });
}

// appendSemanticMemory (memoryStore.ts) throws a bare Error("FOREIGN_NAMESPACE_REJECTED")
// for a namespace that doesn't resolve to this monad's own root -- a real,
// reachable case here (a bare foreign namespace CAN be claimed, and this
// keychain's bootstrap path only requires that claim, not that it be
// locally rooted). Left uncaught, that throw propagated straight past every
// KeychainResult-returning function in this file to Express's own default
// error handler -- an uncaught 500 with no JSON body, instead of the clean,
// structured rejection every OTHER error case in this file already returns.
// This does not change what gets rejected or why, only how the rejection is
// reported: every write below is now wrapped so that specific throw is
// translated into the same KeychainResult shape everything else here uses.
function isForeignNamespaceRejectionError(error: unknown): boolean {
  return error instanceof Error && error.message === "FOREIGN_NAMESPACE_REJECTED";
}

function tryNamespaceWrite(write: () => void): KeychainError | null {
  try {
    write();
    return null;
  } catch (error) {
    if (isForeignNamespaceRejectionError(error)) return "FOREIGN_NAMESPACE_REJECTED";
    throw error;
  }
}

// ─── register ────────────────────────────────────────────────────────────

export interface RegisterKeychainKeyInput {
  namespace: string;
  identityHash?: string; // required for the bootstrap path only
  newKey: { publicKey: string; label: string; admin?: boolean };
  actingKeyId?: string; // required once the keychain is bootstrapped
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function registerKeychainKey(input: RegisterKeychainKeyInput): KeychainResult<KeychainKeyRecord> {
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };

  const publicKeyPem = rawEd25519PublicKeyToPem(input.newKey?.publicKey || "");
  if (!publicKeyPem) return { ok: false, error: "INVALID_PUBLIC_KEY" };

  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const signedFieldsBase: Record<string, unknown> = {
    op: "keychain-register",
    namespace,
    newKey: input.newKey,
    nonce: input.nonce,
    timestamp: input.timestamp,
  };

  const bootstrapped = isKeychainBootstrapped(namespace);

  if (!bootstrapped) {
    // First key only: authorized by the namespace's existing claim -- the
    // recoverable identity's own root signing capability
    // (SeedSession.signPayload()'s key), never a fresh trust anchor. Once
    // the keychain holds an active key, this path is closed -- root
    // intervention after that point is recoverKeychainWithRoot() below,
    // a deliberately distinct, explicit operation, not a variant of
    // ordinary registration. The first key is always admin -- a keychain
    // that starts with zero keys able to administer it would be
    // permanently stuck.
    const identityHash = String(input.identityHash || "").trim();
    if (!identityHash) return { ok: false, error: "IDENTITY_MISMATCH" };
    const claim = getClaim(namespace);
    if (!claim) return { ok: false, error: "CLAIM_REQUIRED" };
    if (claim.identityHash !== identityHash) return { ok: false, error: "IDENTITY_MISMATCH" };

    if (isNonceReplayed(namespace, claim.identityHash, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash: claim.identityHash,
      claimPublicKey: claim.publicKey,
      body: { ...signedFieldsBase, identityHash, signature: input.signature, signedPayload: input.signedPayload },
    });
    if (!authorized) return { ok: false, error: "PROOF_INVALID" };

    consumeNonce(namespace, claim.identityHash, input.nonce);

    const keyId = computeKeyId(publicKeyPem);
    const record: KeychainKeyRecord = {
      keyId,
      label: String(input.newKey.label || "").trim() || "Unnamed key",
      publicKey: publicKeyPem,
      admin: true,
      authorization: "active",
      addedAt: Date.now(),
      addedBy: "bootstrap",
    };
    const writeError = tryNamespaceWrite(() => writeKeyRecord(namespace, record));
    if (writeError) return { ok: false, error: writeError };
    saveSnapshot();
    return { ok: true, value: record };
  }

  // Post-bootstrap: an already-active admin keychain key vouches for the
  // new one. The claim/root key is not consulted again. Whether the new
  // key should itself be admin is the acting admin key's call -- there is
  // only one privilege level here, so an admin key granting admin-or-not
  // to a new key never exceeds its own standing.
  const actingKeyId = String(input.actingKeyId || "").trim();
  if (!actingKeyId) return { ok: false, error: "ACTING_KEY_REQUIRED" };
  const actingKey = getKeychainKey(namespace, actingKeyId);
  if (!actingKey) return { ok: false, error: "ACTING_KEY_NOT_FOUND" };
  if (actingKey.authorization !== "active") return { ok: false, error: "ACTING_KEY_REVOKED" };
  if (!actingKey.admin) return { ok: false, error: "PERMISSION_DENIED" };

  if (isNonceReplayed(namespace, actingKeyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: actingKeyId,
    claimPublicKey: actingKey.publicKey,
    body: { ...signedFieldsBase, actingKeyId, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(namespace, actingKeyId, input.nonce);

  const keyId = computeKeyId(publicKeyPem);
  const record: KeychainKeyRecord = {
    keyId,
    label: String(input.newKey.label || "").trim() || "Unnamed key",
    publicKey: publicKeyPem,
    admin: Boolean(input.newKey.admin),
    authorization: "active",
    addedAt: Date.now(),
    addedBy: actingKeyId,
  };
  const writeError = tryNamespaceWrite(() => writeKeyRecord(namespace, record));
  if (writeError) return { ok: false, error: writeError };
  saveSnapshot();
  return { ok: true, value: record };
}

// ─── revoke ─────────────────────────────────────────────────────────────

export interface RevokeKeychainKeyInput {
  namespace: string;
  actingKeyId: string;
  targetKeyId: string;
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function revokeKeychainKey(input: RevokeKeychainKeyInput): KeychainResult<KeychainKeyRecord> {
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };

  const actingKeyId = String(input.actingKeyId || "").trim();
  const targetKeyId = String(input.targetKeyId || "").trim();
  if (!actingKeyId) return { ok: false, error: "ACTING_KEY_REQUIRED" };
  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const actingKey = getKeychainKey(namespace, actingKeyId);
  if (!actingKey) return { ok: false, error: "ACTING_KEY_NOT_FOUND" };
  if (actingKey.authorization !== "active") return { ok: false, error: "ACTING_KEY_REVOKED" };
  if (!actingKey.admin) return { ok: false, error: "PERMISSION_DENIED" };

  const targetKey = getKeychainKey(namespace, targetKeyId);
  if (!targetKey) return { ok: false, error: "TARGET_KEY_NOT_FOUND" };

  if (
    targetKey.authorization === "active" &&
    targetKey.admin &&
    activeAdminKeyCount(namespace, targetKeyId) === 0
  ) {
    return { ok: false, error: "CANNOT_REVOKE_LAST_ADMIN" };
  }

  if (isNonceReplayed(namespace, actingKeyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const signedFields = { op: "keychain-revoke", namespace, actingKeyId, targetKeyId, nonce: input.nonce, timestamp: input.timestamp };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: actingKeyId,
    claimPublicKey: actingKey.publicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(namespace, actingKeyId, input.nonce);

  const updated: KeychainKeyRecord = {
    ...targetKey,
    authorization: "revoked",
    revokedAt: Date.now(),
    revokedBy: actingKeyId,
  };
  const writeError = tryNamespaceWrite(() => writeKeyRecord(namespace, updated));
  if (writeError) return { ok: false, error: writeError };
  saveSnapshot();
  return { ok: true, value: updated };
}

// ─── sign: prove an active key can sign, nothing more ──────────────────────
// This is deliberately NOT gated by any operation-specific permission --
// the keychain doesn't own that decision. It proves exactly two things:
// this public key is currently active for this identity, and the
// signature verifies. Whatever system actually wants to trust this
// signature for something specific (netget accepting a gateway claim, a
// generic namespace write) makes that call itself, against its own
// authorization model, using the identity this namespace resolves to --
// never by asking the keychain "does this key have permission X."

export interface SignKeychainOperationInput {
  namespace: string;
  keyId: string;
  payload?: unknown;
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function signKeychainOperation(input: SignKeychainOperationInput): KeychainResult<{ opId: string }> {
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };

  const keyId = String(input.keyId || "").trim();
  if (!keyId) return { ok: false, error: "ACTING_KEY_REQUIRED" };
  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const key = getKeychainKey(namespace, keyId);
  if (!key) return { ok: false, error: "ACTING_KEY_NOT_FOUND" };
  if (key.authorization !== "active") return { ok: false, error: "ACTING_KEY_REVOKED" };

  if (isNonceReplayed(namespace, keyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const signedFields = { op: "keychain-sign", namespace, keyId, payload: input.payload ?? null, nonce: input.nonce, timestamp: input.timestamp };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: keyId,
    claimPublicKey: key.publicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(namespace, keyId, input.nonce);

  const opId = crypto.randomUUID();
  const writeError = tryNamespaceWrite(() => appendSemanticMemory({
    namespace,
    path: `${KEYCHAIN_OPERATIONS_BRANCH}.${opId}`,
    data: { opId, keyId, payload: input.payload ?? null, at: Date.now() },
  }));
  if (writeError) return { ok: false, error: writeError };
  saveSnapshot();
  return { ok: true, value: { opId } };
}

// ─── recovery: the case registerKeychainKey's bootstrap path cannot cover ──
// Every delegated key's private half can be lost (a destroyed device, a
// wiped browser profile) while the recoverable identity itself is still
// fine -- that is the entire reason a BIP-39 phrase exists. If the claim
// key's authority to seed the keychain were spent after the first
// registration, losing the last active key would permanently brick the
// keychain even though the identity is fully recoverable. So this is
// reachable at ANY time (keychain empty or not), always via the claim
// key, and it is a full reset, not an addition: every currently-active
// key is revoked and exactly one fresh admin key is minted -- "all
// delegated keys are presumed lost, start over," never "quietly add a
// key alongside ones that might still be fine." That is also why this is
// its own function/endpoint rather than a mode of registerKeychainKey:
// the two operations have different blast radii and must not be
// reachable through the same signed shape.

export interface RecoverKeychainInput {
  namespace: string;
  identityHash: string;
  newKey: { publicKey: string; label: string };
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function recoverKeychainWithRoot(input: RecoverKeychainInput): KeychainResult<KeychainKeyRecord> {
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };

  const publicKeyPem = rawEd25519PublicKeyToPem(input.newKey?.publicKey || "");
  if (!publicKeyPem) return { ok: false, error: "INVALID_PUBLIC_KEY" };

  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const identityHash = String(input.identityHash || "").trim();
  if (!identityHash) return { ok: false, error: "IDENTITY_MISMATCH" };
  const claim = getClaim(namespace);
  if (!claim) return { ok: false, error: "CLAIM_REQUIRED" };
  if (claim.identityHash !== identityHash) return { ok: false, error: "IDENTITY_MISMATCH" };

  const replayScope = `root-recovery:${claim.identityHash}`;
  if (isNonceReplayed(namespace, replayScope, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const signedFields = {
    op: "keychain-recovery",
    namespace,
    identityHash,
    newKey: input.newKey,
    nonce: input.nonce,
    timestamp: input.timestamp,
  };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: claim.identityHash,
    claimPublicKey: claim.publicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(namespace, replayScope, input.nonce);

  const now = Date.now();
  for (const existing of listKeychainKeys(namespace)) {
    if (existing.authorization === "active") {
      const revokeWriteError = tryNamespaceWrite(() => writeKeyRecord(namespace, {
        ...existing,
        authorization: "revoked",
        revokedAt: now,
        revokedBy: "root-recovery",
      }));
      if (revokeWriteError) return { ok: false, error: revokeWriteError };
    }
  }

  const keyId = computeKeyId(publicKeyPem);
  const record: KeychainKeyRecord = {
    keyId,
    label: String(input.newKey.label || "").trim() || "Recovered key",
    publicKey: publicKeyPem,
    admin: true,
    authorization: "active",
    addedAt: now,
    addedBy: "root-recovery",
  };
  const writeError = tryNamespaceWrite(() => writeKeyRecord(namespace, record));
  if (writeError) return { ok: false, error: writeError };
  saveSnapshot();
  return { ok: true, value: record };
}
