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
 * authority on its own. `bootstrapGatewayAuthority` additionally requires
 * the claiming namespace to be rooted in THIS installation's own
 * configured identity (`isNamespaceLocalToThisInstallation`) — see that
 * function's own doc comment for what this does and does not close.
 *
 * LIVE-VERIFIED GUARANTEES (2026-09-13, disposable infra, real HTTP, real
 * process restarts — see the cited test files, not just unit coverage):
 *   - Bootstrap is atomic under concurrency: two simultaneous bootstrap
 *     requests for the same gatewayId from two different real identities
 *     produce exactly one winner, never two, never a torn record
 *     (tests/gatewayAuthority.test.ts).
 *   - The canonical branch survives a REAL monad process restart (kill +
 *     relaunch, same on-disk state dir) — netget's local cache, even after
 *     being deleted entirely, recovers the exact same owner by reading
 *     this branch back; a different identity still cannot rebootstrap
 *     post-restart (modules/netget/Typescript/tests/gateway-authority-
 *     durability.test.ts).
 *   - Revoking gateway-admin status takes effect on an ALREADY-ISSUED
 *     admin session's very next use — the same session token, the same
 *     never-revoked signing key — while an identity that retains authority
 *     keeps working (modules/netget/Typescript/tests/gateway-admin-
 *     session-revocation.test.ts).
 */

import { parseNamespaceExpression } from "cleaker";
import { getClaim } from "./records.js";
import { isNamespaceWriteAuthorized } from "./replay.js";
import { getKeychainKey } from "./keychain.js";
import {
  getKernel,
  getKernelStateDir,
  isRecognizedOwnRootConstant,
  readDurableSnapshotValue,
  saveSnapshot,
  saveSnapshotOrThrow,
} from "../kernel/manager.js";
import { normalizeNamespaceIdentity, normalizeNamespaceRootName } from "../namespace/identity.js";
import {
  beginInstallationAuthorizationConsumption,
  finalizeInstallationAuthorization,
  type InstallationAuthorizationError,
} from "./installationAuthorization.js";

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
  | "CANNOT_REVOKE_OWNER"
  | "NAMESPACE_NOT_LOCAL_TO_THIS_INSTALLATION"
  | InstallationAuthorizationError
  | "INSTALLATION_AUTHORIZATION_PERSIST_FAILED";

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

/**
 * Is `namespace` genuinely rooted in THIS monad's own configured identity
 * (isRecognizedOwnRootConstant() — accepts ME_NAMESPACE/getRootNamespace()
 * or the MONAD_SELF_IDENTITY alias, both set once at process startup, never
 * attacker-influenced per-request)? Reuses the exact root-recognition
 * kernel/manager.ts's own isForeignNamespaceCollapsingToRoot() is built
 * from, rather than re-deriving a second, possibly-drifting definition of
 * "is this genuinely local."
 *
 * Why this exists: bootstrapGatewayAuthority previously only checked that
 * SOME namespace claim + active key existed — with no relationship
 * verified between that namespace and this specific installation.
 *
 * INVESTIGATED (2026-09, before adding this check — do not assume the
 * obvious attack below is exploitable without re-checking this note first):
 * claimNamespace()'s own materializeProjectedNamespaceClaim() already
 * throws FOREIGN_NAMESPACE_REJECTED (via appendSemanticMemory's existing
 * guard) for any COMPOUND namespace whose root doesn't match this monad's
 * own — so an attacker can't obtain a genuine claim for a foreign compound
 * namespace here at all. A BARE foreign root namespace (no prefix) CAN be
 * claimed, but registering a keychain key against it fails for the exact
 * same reason (keychain.ts's own writeKeyRecord() writes through the same
 * guard). So today, reaching bootstrapGatewayAuthority with BOTH a real
 * claim AND an active key for a genuinely foreign namespace is not
 * possible via the standard claim+keychain HTTP flow — this check is
 * therefore defense-in-depth, not closing a currently-reachable exploit:
 * it makes the guarantee explicit and local to the function that most
 * needs it, rather than relying on being an accidental side effect of
 * unrelated code elsewhere (which could silently stop applying if that
 * other code ever changes). See claim/gatewayAuthority.test.ts's own
 * direct unit test of this function for why an HTTP-level repro of the
 * "attacker" side isn't included: the precondition it would need isn't
 * constructible through the real flow.
 */
/** @internal exported for gatewayAuthority.test.ts's direct unit test only
 *  — see this function's own doc comment for why an HTTP-level repro of
 *  the rejected case isn't constructible through the real claim+keychain
 *  flow. */
export function isNamespaceLocalToThisInstallation(namespace: string): boolean {
  let parsed: ReturnType<typeof parseNamespaceExpression>;
  try {
    parsed = parseNamespaceExpression(namespace);
  } catch {
    return false;
  }
  const constant = normalizeNamespaceRootName(parsed.constant);
  return Boolean(constant) && isRecognizedOwnRootConstant(constant);
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

/**
 * Same as readGatewayAuthority(), but reads the actual snapshot.json on
 * disk (via readDurableSnapshotValue()) instead of the in-memory kernel.
 * Used by every authorization-sensitive gate in this file —
 * bootstrapGatewayAuthority()'s own first-bootstrap check AND
 * resolveActingIdentity() (grant/revoke/transfer) — so a phantom in-
 * memory owner/admin (kernelSet succeeded, the durable persist that's
 * supposed to follow it did not — see installationAuthorization.ts's
 * header comment) is never mistaken for confirmed authority anywhere a
 * real, durably-persisted side effect could result from trusting it.
 * Confirmed empirically that this matters even though the ONE failure
 * mode this session could reproduce (an unwritable state directory) makes
 * `kernelSet` itself fail atomically before any in-memory mutation is
 * visible: that atomicity is a property of THIS specific failure mode,
 * not a guarantee this file's own correctness should depend on for every
 * possible way a later durable-persist step could fail. Not used by the
 * public read endpoint (`readGatewayAuthorityHandler`) or by
 * `listKeychainKeys`-style listings — those are informational, not an
 * authorization decision; widening this to every read site in the
 * codebase is a larger, separate change than this fix's scope.
 */
function readDurableGatewayAuthority(gatewayId: string): GatewayAuthorityRecord | undefined {
  const id = String(gatewayId || "").trim();
  if (!id) return undefined;
  const value = readDurableSnapshotValue(gatewayPath(id));
  return value === undefined || value === null ? undefined : (value as GatewayAuthorityRecord);
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

  if (!isNamespaceLocalToThisInstallation(namespace)) {
    return { ok: false, error: "NAMESPACE_NOT_LOCAL_TO_THIS_INSTALLATION" };
  }

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

  // Durable-verified, not the in-memory read: see readDurableGatewayAuthority()'s
  // own doc comment for why a phantom in-memory-only owner must never be
  // trusted at this specific decision point.
  const existingDurable = readDurableGatewayAuthority(gatewayId);
  if (existingDurable?.owner && existingDurable.owner !== identityHash) {
    return { ok: false, error: "ALREADY_BOOTSTRAPPED" };
  }

  const isFirstBootstrap = !existingDurable?.owner;
  const stateDir = getKernelStateDir();

  // Genuinely never durably bootstrapped: the ONE case that needs proof of
  // installation authorization (see installationAuthorization.ts). A valid
  // namespace claim + active key under this monad's own root is, on its
  // own, no longer sufficient to win first-bootstrap of an arbitrary
  // gatewayId — that was exactly the gap this closes.
  if (isFirstBootstrap) {
    let authResult;
    try {
      authResult = beginInstallationAuthorizationConsumption({
        stateDir,
        gatewayId,
        namespace,
        identityHash,
        isDurablyBootstrapped: () => readDurableGatewayAuthority(gatewayId)?.owner === identityHash,
      });
    } catch {
      // A real filesystem failure marking "in-flight" itself (e.g. the
      // state dir just became unwritable) — nothing was consumed, nothing
      // to revert; report it the same way a later persist failure would be.
      return { ok: false, error: "INSTALLATION_AUTHORIZATION_PERSIST_FAILED" };
    }
    if (!authResult.ok) return { ok: false, error: authResult.error };
  }

  consumeNonce(`bootstrap:${gatewayId}`, identityHash, input.challenge);

  const username = input.username ? String(input.username).trim() : undefined;
  const record: GatewayAuthorityRecord = existingDurable ?? emptyRecord(gatewayId);
  record.owner = identityHash;
  record.admins[identityHash] = true;
  if (!record.grants[identityHash]) record.grants[identityHash] = [];
  record.namespaces[identityHash] = namespace;
  // Stored PEM, matching this monad's own keychain/claim convention — netget's
  // materializeFromGatewayAuthority() converts to the raw base64url form its
  // own GatewayClaimsSnapshot.pubkeys map expects.
  record.pubkeys[identityHash] = key.publicKey;
  if (username) record.usernames[identityHash] = username;

  if (!isFirstBootstrap) {
    // Idempotent re-bootstrap by the already-durable owner (e.g. refreshing
    // a rotated key) — no installation authorization involved, same as
    // before this change.
    persist(record);
    return { ok: true, value: record };
  }

  let durablyPersisted = false;
  try {
    kernelSet(gatewayPath(gatewayId), { ...record, updatedAt: Date.now() });
    saveSnapshotOrThrow();
    const verified = readDurableGatewayAuthority(gatewayId);
    if (verified?.owner !== identityHash) {
      throw new Error("DURABILITY_VERIFICATION_FAILED");
    }
    // The durable write itself is now confirmed — a failure from here on
    // (finalizing the authorization file's own bookkeeping) must NOT be
    // reported as a persist failure: the guarantee that actually matters
    // (the owner survives on disk) already holds.
    durablyPersisted = true;
    finalizeInstallationAuthorization(stateDir, gatewayId, "consumed");
    return { ok: true, value: record };
  } catch {
    if (durablyPersisted) {
      // Only finalizeInstallationAuthorization("consumed") failed — the
      // record itself may be left stuck "in-flight" (harmless bookkeeping
      // debt: the next read of this exact record resolves it via
      // beginInstallationAuthorizationConsumption's own reclaim-against-
      // durable-truth logic, which will see the owner really is durable
      // and finalize it to "consumed" then). The bootstrap itself
      // genuinely succeeded — report that, not a false failure.
      return { ok: true, value: record };
    }
    // The in-memory kernel may now hold this record even though it never
    // reached disk (kernelSet already ran) — harmless: every future
    // decision at THIS gate reads readDurableGatewayAuthority() (disk-
    // verified), never the in-memory value, so the phantom write is simply
    // ignored rather than needing to be explicitly rolled back. The
    // authorization itself goes back to "pending" so a genuine retry (the
    // same operator, same still-valid setup window) can succeed once the
    // underlying write actually lands.
    //
    // This revert-to-"pending" write can ITSELF fail (e.g. the same
    // filesystem failure that just broke saveSnapshotOrThrow() also blocks
    // writing installation-authorizations.json, since both live under the
    // same stateDir) — that must never escape as a second, uncaught
    // exception on top of the first. Left "in-flight" in that rare double-
    // failure case, it's still fully recoverable later: the very next
    // attempt's own reclaim logic (beginInstallationAuthorizationConsumption)
    // resolves an in-flight record against durable truth, not elapsed
    // time, and finds no durable owner here — reclaiming it to "pending"
    // itself once the filesystem is writable again.
    try {
      finalizeInstallationAuthorization(stateDir, gatewayId, "pending");
    } catch {
      // Swallowed on purpose — see comment above.
    }
    return { ok: false, error: "INSTALLATION_AUTHORIZATION_PERSIST_FAILED" };
  }
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

  // Durable-verified, not the in-memory read — same reasoning as
  // bootstrapGatewayAuthority's own first-bootstrap gate (see
  // readDurableGatewayAuthority's doc comment): granting/revoking/
  // transferring authority off an owner/admin record that only exists in
  // memory (a bootstrap whose kernelSet ran but whose durable persist
  // never confirmed) would let a never-actually-established owner still
  // produce a REAL, durably-persisted side effect through this path —
  // e.g. granting a third party — even though the acting identity was
  // never confirmed as owner at all.
  const record = readDurableGatewayAuthority(gatewayId);
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

  return applyGatewayAdminRevocation(record, targetIdentityHash);
}

/** The actual state change behind revokeGatewayAdmin, factored out so an ALREADY-authorized caller can
 *  apply it without re-deriving these five field deletions. Performs NO authorization check of its own --
 *  every caller is responsible for having verified authority first. revokeGatewayAdmin (above) is one such
 *  caller, after its own actingKeyId/keychain-signature check; gatewayNodeGrants.ts's delegated revoke is
 *  the other, after its own node-grant + live-capability guard -- two different authorization paths
 *  converging on the one real mutation, so neither can drift from what "revoked" actually means on disk. */
export function applyGatewayAdminRevocation(record: GatewayAuthorityRecord, targetIdentityHash: string): GatewayAuthorityResult<GatewayAuthorityRecord> {
  if (targetIdentityHash === record.owner) return { ok: false, error: "CANNOT_REVOKE_OWNER" };

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
