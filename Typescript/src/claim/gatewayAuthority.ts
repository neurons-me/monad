/**
 * gatewayAuthority.ts — canonical, signed owner/admins/grants state for a
 * netget gateway INSTALLATION, living in `.me` (this monad's kernel) rather
 * than in netget's own local `gateway-claims.json`.
 *
 * Why this exists: `GatewayClaimsManager`'s old model let netget write its
 * own ledger unsigned, correct only when netget exclusively owned an
 * unclaimed monad. The namespace-derived claim model removed that
 * assumption — the underlying monad now genuinely holds a `.me` claim, and
 * `commandHandler.ts`'s write path rejects an unsigned write with
 * `NAMESPACE_WRITE_FORBIDDEN`. Netget must never hold the operator's
 * private key, so it can't just sign that write itself either. This module
 * is the fix: authority lives here, signed mutations are verified HERE
 * (independently — never trusting that some other process already
 * checked), and netget's only remaining job is reading the confirmed state
 * back (`readGatewayAuthority`) to materialize its own local cache for Lua.
 *
 * Storage is namespace-INDEPENDENT and kernel-root-scoped
 * (`daemon.gateways.<gatewayIdKey>`), deliberately not nested under any
 * one identity's `users.<handle>` tree — a gateway's authority belongs to
 * the INSTALLATION, and transferring ownership must never require moving
 * state into a different user's personal branch. This mirrors
 * `records.ts`'s own `daemon.claims.<nsKey>` precedent (a single JSON blob
 * at a computed path via the kernel proxy, not the per-namespace semantic-
 * memory branch API `keychain.ts` uses — this doesn't need per-field audit
 * rows).
 *
 * Two independent checks gate every mutation, deliberately never
 * conflated (this is the exact split reviewed and required): "vigencia" —
 * is the signing key CURRENTLY ACTIVE for the identity it claims to speak
 * for right now (`getKeychainKey`, fetched fresh, never cached) — and
 * "autorización" — does THAT IDENTITY currently hold gateway authority,
 * checked against THIS branch's own state (`record.admins`), never
 * inferred from the keychain's own `admin` flag (which only means "can
 * administer THAT keychain," a different privilege — see keychain.ts's own
 * header comment for the same principle from the other side). A validly-
 * signed message from a perfectly live key proves nothing about gateway
 * authority on its own.
 */

import { getClaim } from "./records.js";
import { isNamespaceWriteAuthorized } from "./replay.js";
import { getKeychainKey } from "./keychain.js";
import { getKernel, saveSnapshot } from "../kernel/manager.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";

export interface GatewayAuthorityRecord {
  gatewayId: string;
  owner: string | null;
  /** identityHash -> true. Owner is always also present here. */
  admins: Record<string, true>;
  /** identityHash -> opaque scope strings. Never a netget-specific type here. */
  grants: Record<string, string[]>;
  pubkeys: Record<string, string>;
  usernames: Record<string, string>;
  /** identityHash -> the namespace whose keychain backs this identity's
   *  FUTURE signed actions on this gateway. */
  namespaces: Record<string, string>;
  updatedAt: number;
}

export type GatewayAuthorityError =
  | "GATEWAY_ID_REQUIRED"
  | "NAMESPACE_REQUIRED"
  | "CLAIM_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "PROOF_REQUIRED"
  | "PROOF_INVALID"
  | "REPLAY_REJECTED"
  | "ALREADY_BOOTSTRAPPED"
  | "GATEWAY_NOT_BOOTSTRAPPED"
  | "ACTING_KEY_NOT_FOUND"
  | "ACTING_KEY_REVOKED"
  | "PERMISSION_DENIED"
  | "OWNER_ONLY"
  | "TARGET_NOT_ADMIN"
  | "CANNOT_REVOKE_OWNER";

export type GatewayAuthorityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GatewayAuthorityError };

const GATEWAY_ROOT = "daemon.gateways";
// Anti-replay window for nonce-based operations (grant/revoke/transfer) —
// same value as keychain.ts's REPLAY_WINDOW_MS, no reason to diverge.
const REPLAY_WINDOW_MS = 120_000;

function nav(root: any, path: string): any {
  return path.split(".").reduce((proxy: any, key: string) => proxy[key], root);
}

function kernelGet(path: string): GatewayAuthorityRecord | undefined {
  const kernelRead = getKernel() as unknown as (rawPath: string) => unknown;
  const result = kernelRead(path);
  return result === undefined || result === null ? undefined : (result as GatewayAuthorityRecord);
}

function kernelSet(path: string, value: unknown): void {
  nav(getKernel(), path)(value);
}

function gatewayIdKey(gatewayId: string): string {
  return gatewayId.replace(/\./g, "__");
}

function gatewayPath(gatewayId: string): string {
  return `${GATEWAY_ROOT}.${gatewayIdKey(gatewayId)}`;
}

/** True for any raw (pre-namespace-projection) path a generic namespace
 *  write must never be allowed to touch — mirrors keychain.ts's
 *  isKeychainReservedPath() exactly, including checking it regardless of
 *  which namespace's write it would land under (this branch is kernel-
 *  root/namespace-independent, but a namespace that legitimately resolves
 *  to this monad's own configured root writes UNPREFIXED at literal
 *  kernel root via the generic surface — see kernel/manager.ts's
 *  isForeignNamespaceCollapsingToRoot() for why that case is real). */
export function isGatewayAuthorityReservedPath(pathInput: string): boolean {
  const path = String(pathInput || "").trim();
  return path === "daemon" || path === GATEWAY_ROOT || path.startsWith(`${GATEWAY_ROOT}.`);
}

// ─── replay cache ───────────────────────────────────────────────────────
const _seenNonces = new Map<string, number>();

export function resetGatewayAuthorityNonceCacheForTests(): void {
  _seenNonces.clear();
}

function isFreshTimestamp(timestamp: unknown): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= REPLAY_WINDOW_MS;
}

function replayKey(scope: string, actor: string, nonce: string): string {
  return `${scope}:${actor}:${nonce}`;
}

function isReplayed(scope: string, actor: string, nonce: string): boolean {
  const key = replayKey(scope, actor, nonce);
  const expiry = _seenNonces.get(key);
  return expiry !== undefined && expiry >= Date.now();
}

function consumeNonce(scope: string, actor: string, nonce: string): void {
  const key = replayKey(scope, actor, nonce);
  _seenNonces.set(key, Date.now() + REPLAY_WINDOW_MS);
  if (_seenNonces.size > 10_000) {
    const now = Date.now();
    for (const [k, exp] of _seenNonces) if (exp < now) _seenNonces.delete(k);
  }
}

// ─── reads ──────────────────────────────────────────────────────────────

export function readGatewayAuthority(gatewayId: string): GatewayAuthorityRecord | null {
  const id = String(gatewayId || "").trim();
  if (!id) return null;
  return kernelGet(gatewayPath(id)) ?? null;
}

function emptyRecord(gatewayId: string): GatewayAuthorityRecord {
  return {
    gatewayId,
    owner: null,
    admins: {},
    grants: {},
    pubkeys: {},
    usernames: {},
    namespaces: {},
    updatedAt: Date.now(),
  };
}

function persist(record: GatewayAuthorityRecord): void {
  kernelSet(gatewayPath(record.gatewayId), { ...record, updatedAt: Date.now() });
  saveSnapshot();
}

// ─── bootstrap ──────────────────────────────────────────────────────────

export interface BootstrapGatewayAuthorityInput {
  gatewayId: string;
  namespace: string;
  identityHash: string;
  keyId: string;
  challenge: string;
  timestamp: number;
  signature: string;
  username?: string;
}

/**
 * First-write-wins, matching materializeFromNamespaceClaim()'s existing
 * invariant. Idempotent for the SAME identity re-bootstrapping — this
 * doubles as the migration path for an install that already has a local
 * gateway-claims.json under the old model: calling this again with the
 * same real owner identity is a no-op success, not an error.
 *
 * Reuses the EXACT message shape gatewaySetupSession.ts's commitSignedClaim
 * already verifies (op:'netget-claim-gateway') — this is not a second,
 * different thing the browser must sign; netget forwards the SAME already-
 * verified proof here, and this function verifies it AGAIN, independently,
 * against the live keychain key it looks up itself.
 */
export function bootstrapGatewayAuthority(input: BootstrapGatewayAuthorityInput): GatewayAuthorityResult<GatewayAuthorityRecord> {
  const gatewayId = String(input.gatewayId || "").trim();
  if (!gatewayId) return { ok: false, error: "GATEWAY_ID_REQUIRED" };
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };

  const identityHash = String(input.identityHash || "").trim();
  const keyId = String(input.keyId || "").trim();
  if (!identityHash || !keyId) return { ok: false, error: "IDENTITY_MISMATCH" };
  if (!input.challenge || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const claim = getClaim(namespace);
  if (!claim) return { ok: false, error: "CLAIM_REQUIRED" };
  if (claim.identityHash !== identityHash) return { ok: false, error: "IDENTITY_MISMATCH" };

  const key = getKeychainKey(namespace, keyId);
  if (!key) return { ok: false, error: "ACTING_KEY_NOT_FOUND" };
  if (key.authorization !== "active") return { ok: false, error: "ACTING_KEY_REVOKED" };

  if (isReplayed(`bootstrap:${gatewayId}`, identityHash, input.challenge)) {
    return { ok: false, error: "REPLAY_REJECTED" };
  }

  const signedFields = {
    op: "netget-claim-gateway",
    gatewayId,
    namespace,
    identityHash,
    keyId,
    challenge: input.challenge,
    timestamp: input.timestamp,
  };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: keyId,
    claimPublicKey: key.publicKey,
    body: { ...signedFields, signature: input.signature },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  const existing = readGatewayAuthority(gatewayId);
  if (existing?.owner && existing.owner !== identityHash) {
    return { ok: false, error: "ALREADY_BOOTSTRAPPED" };
  }

  consumeNonce(`bootstrap:${gatewayId}`, identityHash, input.challenge);

  const username = input.username ? String(input.username).trim() : undefined;
  const record: GatewayAuthorityRecord = existing ?? emptyRecord(gatewayId);
  record.owner = identityHash;
  record.admins[identityHash] = true;
  if (!record.grants[identityHash]) record.grants[identityHash] = [];
  record.namespaces[identityHash] = namespace;
  // Stored PEM, matching this monad's own keychain/claim convention — netget's
  // materializeFromGatewayAuthority() converts to the raw base64url form its
  // own GatewayClaimsSnapshot.pubkeys map expects.
  record.pubkeys[identityHash] = key.publicKey;
  if (username) record.usernames[identityHash] = username;

  persist(record);
  return { ok: true, value: record };
}

// ─── shared acting-key + authorization check ───────────────────────────

function resolveActingIdentity(
  gatewayId: string,
  namespace: string,
  actingKeyId: string,
): GatewayAuthorityResult<{ record: GatewayAuthorityRecord; actingIdentity: string; actingKeyPublicKey: string }> {
  const key = getKeychainKey(namespace, actingKeyId);
  if (!key) return { ok: false, error: "ACTING_KEY_NOT_FOUND" };
  if (key.authorization !== "active") return { ok: false, error: "ACTING_KEY_REVOKED" };

  const claim = getClaim(namespace);
  if (!claim) return { ok: false, error: "CLAIM_REQUIRED" };
  const actingIdentity = claim.identityHash;

  const record = readGatewayAuthority(gatewayId);
  if (!record || !record.owner) return { ok: false, error: "GATEWAY_NOT_BOOTSTRAPPED" };

  // The authorization check: does THIS IDENTITY currently hold gateway
  // authority, per the branch's OWN state. Never inferred from key.admin
  // (that flag means "can administer the keychain," a different, narrower
  // privilege — see this file's own header comment).
  if (record.admins[actingIdentity] !== true) return { ok: false, error: "PERMISSION_DENIED" };

  return { ok: true, value: { record, actingIdentity, actingKeyPublicKey: key.publicKey } };
}

// ─── grant ──────────────────────────────────────────────────────────────

export interface GrantGatewayAdminInput {
  gatewayId: string;
  namespace: string;
  actingKeyId: string;
  targetIdentityHash: string;
  targetNamespace: string;
  /** Informational only, stored as-is (PEM, matching bootstrapGatewayAuthority's
   *  convention) — not independently verified here, since the TARGET hasn't
   *  signed anything in a grant. It gets authoritatively re-established the
   *  moment the target identity itself ever bootstraps or signs something
   *  through this file's own functions. */
  targetPublicKey?: string;
  targetUsername?: string;
  scopes: string[];
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function grantGatewayAdmin(input: GrantGatewayAdminInput): GatewayAuthorityResult<GatewayAuthorityRecord> {
  const gatewayId = String(input.gatewayId || "").trim();
  if (!gatewayId) return { ok: false, error: "GATEWAY_ID_REQUIRED" };
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };
  const actingKeyId = String(input.actingKeyId || "").trim();
  const targetIdentityHash = String(input.targetIdentityHash || "").trim();
  const targetNamespace = normalizeNamespaceIdentity(input.targetNamespace);
  if (!actingKeyId || !targetIdentityHash || !targetNamespace) return { ok: false, error: "IDENTITY_MISMATCH" };
  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const resolved = resolveActingIdentity(gatewayId, namespace, actingKeyId);
  if (!resolved.ok) return resolved;
  const { record, actingKeyPublicKey } = resolved.value;

  if (isReplayed(`grant:${gatewayId}`, actingKeyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const scopes = Array.isArray(input.scopes) ? input.scopes.map(String) : [];
  const signedFields = {
    op: "gateway-grant-admin",
    gatewayId,
    namespace,
    targetIdentityHash,
    targetNamespace,
    targetPublicKey: input.targetPublicKey ?? null,
    targetUsername: input.targetUsername ?? null,
    scopes,
    nonce: input.nonce,
    timestamp: input.timestamp,
  };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: actingKeyId,
    claimPublicKey: actingKeyPublicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(`grant:${gatewayId}`, actingKeyId, input.nonce);

  record.admins[targetIdentityHash] = true;
  record.grants[targetIdentityHash] = scopes;
  record.namespaces[targetIdentityHash] = targetNamespace;
  if (input.targetPublicKey) record.pubkeys[targetIdentityHash] = input.targetPublicKey;
  if (input.targetUsername) record.usernames[targetIdentityHash] = input.targetUsername;

  persist(record);
  return { ok: true, value: record };
}

// ─── revoke ─────────────────────────────────────────────────────────────

export interface RevokeGatewayAdminInput {
  gatewayId: string;
  namespace: string;
  actingKeyId: string;
  targetIdentityHash: string;
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export function revokeGatewayAdmin(input: RevokeGatewayAdminInput): GatewayAuthorityResult<GatewayAuthorityRecord> {
  const gatewayId = String(input.gatewayId || "").trim();
  if (!gatewayId) return { ok: false, error: "GATEWAY_ID_REQUIRED" };
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };
  const actingKeyId = String(input.actingKeyId || "").trim();
  const targetIdentityHash = String(input.targetIdentityHash || "").trim();
  if (!actingKeyId || !targetIdentityHash) return { ok: false, error: "IDENTITY_MISMATCH" };
  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const resolved = resolveActingIdentity(gatewayId, namespace, actingKeyId);
  if (!resolved.ok) return resolved;
  const { record, actingKeyPublicKey } = resolved.value;

  if (targetIdentityHash === record.owner) return { ok: false, error: "CANNOT_REVOKE_OWNER" };

  if (isReplayed(`revoke:${gatewayId}`, actingKeyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const signedFields = { op: "gateway-revoke-admin", gatewayId, namespace, targetIdentityHash, nonce: input.nonce, timestamp: input.timestamp };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: actingKeyId,
    claimPublicKey: actingKeyPublicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(`revoke:${gatewayId}`, actingKeyId, input.nonce);

  delete record.admins[targetIdentityHash];
  delete record.grants[targetIdentityHash];
  delete record.pubkeys[targetIdentityHash];
  delete record.usernames[targetIdentityHash];
  delete record.namespaces[targetIdentityHash];

  persist(record);
  return { ok: true, value: record };
}

// ─── transfer ───────────────────────────────────────────────────────────

export interface TransferGatewayOwnerInput {
  gatewayId: string;
  namespace: string;
  actingKeyId: string;
  targetIdentityHash: string;
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

/**
 * Owner-only — tightens a latent gap the old unsigned transferOwner()
 * never actually checked (any admin could call it). The target must
 * already be a gateway admin, matching the existing invariant.
 */
export function transferGatewayOwner(input: TransferGatewayOwnerInput): GatewayAuthorityResult<GatewayAuthorityRecord> {
  const gatewayId = String(input.gatewayId || "").trim();
  if (!gatewayId) return { ok: false, error: "GATEWAY_ID_REQUIRED" };
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return { ok: false, error: "NAMESPACE_REQUIRED" };
  const actingKeyId = String(input.actingKeyId || "").trim();
  const targetIdentityHash = String(input.targetIdentityHash || "").trim();
  if (!actingKeyId || !targetIdentityHash) return { ok: false, error: "IDENTITY_MISMATCH" };
  if (!input.nonce || !input.signature) return { ok: false, error: "PROOF_REQUIRED" };
  if (!isFreshTimestamp(input.timestamp)) return { ok: false, error: "PROOF_INVALID" };

  const resolved = resolveActingIdentity(gatewayId, namespace, actingKeyId);
  if (!resolved.ok) return resolved;
  const { record, actingIdentity, actingKeyPublicKey } = resolved.value;

  if (actingIdentity !== record.owner) return { ok: false, error: "OWNER_ONLY" };
  if (record.admins[targetIdentityHash] !== true) return { ok: false, error: "TARGET_NOT_ADMIN" };

  if (isReplayed(`transfer:${gatewayId}`, actingKeyId, input.nonce)) return { ok: false, error: "REPLAY_REJECTED" };

  const signedFields = { op: "gateway-transfer-owner", gatewayId, namespace, targetIdentityHash, nonce: input.nonce, timestamp: input.timestamp };
  const authorized = isNamespaceWriteAuthorized({
    claimIdentityHash: actingKeyId,
    claimPublicKey: actingKeyPublicKey,
    body: { ...signedFields, signature: input.signature, signedPayload: input.signedPayload },
  });
  if (!authorized) return { ok: false, error: "PROOF_INVALID" };

  consumeNonce(`transfer:${gatewayId}`, actingKeyId, input.nonce);

  record.owner = targetIdentityHash;

  persist(record);
  return { ok: true, value: record };
}
