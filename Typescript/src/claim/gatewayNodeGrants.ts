/**
 * gatewayNodeGrants.ts — the guard GatewayAccessContract.md §9 calls for, closed: an executor may act on
 * a gateway only when BOTH hold, checked fresh, on every single action, never cached from grant time:
 *
 *   (1) the GRANTING identity currently holds the capability on the gateway (gatewayCapabilities.ts,
 *       consulting gatewayAuthority.ts's own live record -- never the identity's standing as of when the
 *       grant was issued), AND
 *   (2) the executor currently holds a live, matching node grant naming that capability
 *       (nodeGrants.ts's verifyExecutorAction -- signature, expiry, revocation, all re-checked fresh).
 *
 * AND, never OR (design doc §8's own closing line). The case this file exists to close, found not yet
 * verified in review: an admin grants an app a gateway operation, then is later revoked as admin. The
 * node grant record itself is untouched -- not expired, not revoked, and the admin's own keychain key is
 * still perfectly active (vigencia alone says nothing here). Without re-reading the identity's CURRENT
 * gateway standing on every action, the app would keep working on inherited authority its granter no
 * longer holds. `hasGatewayCapability` is called here with a freshly-read `GatewayAuthorityRecord` on
 * every call, precisely so that the moment `revokeGatewayAdmin` runs, this guard's very next check for
 * that identity fails -- the same "checked fresh, not cached" guarantee `gatewayAuthority.ts`'s own admin-
 * session precedent already established, now extended one layer further (through a node grant) rather
 * than assumed to stop at the identity boundary.
 *
 * Also closes a second, narrower gap while wiring this: `operations` on a plain node grant are opaque
 * strings (nodeGrants.ts's own design), so a grant over an unrelated node could coincidentally list a
 * string that happens to match a real gateway capability name. This file additionally requires the
 * grant's own `nodePath` to genuinely be the gateway's control coordinate (`daemon.gateways.<gatewayId>`)
 * or a narrower node under it -- matching design doc §3 ("gatewayId is added only when the resource is a
 * gateway; nodePath is the gateway's own control surface") -- so a grant over `dashboard.status` can never
 * satisfy a gateway check no matter what its `operations` array happens to contain.
 *
 * `verifyExecutorGatewayAction` returns an authorization VERDICT only -- callers decide what to do with
 * it. `revokeGatewayAdminViaNodeGrant` below is this file's first CONNECTED operation (review correction,
 * 2026-09-22): a verdict alone still let a caller treat one `ok` as reusable permission for a separately-
 * issued mutation. Instead, the concrete action is a single function that checks and applies in the same
 * flow, off the SAME signed request -- there is no point between "authorized" and "applied" where a
 * caller could take the verdict elsewhere. Three things this closes, exactly as specified:
 *   - the SERVER decides which capability an action requires (`REVOKE_ADMIN_CAPABILITY`, a fixed
 *     constant), never a capability string the caller supplies -- the caller cannot claim a lenient
 *     operation name to reach a stricter action;
 *   - the executor's signature covers the exact mutation parameters (`{ targetIdentityHash }`, inside
 *     `params`, per nodeGrants.ts's §5 contract) -- a signature obtained for revoking one identity can
 *     never be replayed against a different one;
 *   - authorization and the mutation happen in the same synchronous call, against the SAME freshly-read
 *     `GatewayAuthorityRecord` the guard already fetched -- no second read, no window between "checked"
 *     and "applied" where the record could have changed underneath the decision.
 * The pre-existing `POST /api/v1/gateway/:gatewayId/admins/:id/revoke` route (gatewayAuthority.ts's own
 * `revokeGatewayAdmin`, keyed to the acting identity's own keychain signature) is UNCHANGED -- this file
 * only factors its mutation into a shared `applyGatewayAdminRevocation` so both authorization paths
 * converge on the one real state change, never so the old route's own check could be skipped.
 */
import { verifyExecutorAction, nodePathCovers, type ExecutorActionInput, type ExecutorActionError } from "./nodeGrants.js";
import {
  readGatewayAuthority,
  applyGatewayAdminRevocation,
  type GatewayAuthorityRecord,
  type GatewayAuthorityError,
} from "./gatewayAuthority.js";
import { hasGatewayCapability } from "./gatewayCapabilities.js";

const GATEWAY_CONTROL_ROOT = "daemon.gateways";

/** The capability revoking a gateway admin requires -- decided HERE, by the server, never read from the
 *  caller's own request. An executor's node grant must itself have been granted this exact string by an
 *  identity who currently holds it; see this file's header for why the caller never gets to name it. */
export const REVOKE_ADMIN_CAPABILITY = "admins:manage";

export type GatewayGuardError = ExecutorActionError | "GATEWAY_ID_REQUIRED" | "IDENTITY_CAPABILITY_MISSING";

export type GatewayGuardResult =
  | { ok: true; identityHash: string; gatewayId: string; operation: string; record: GatewayAuthorityRecord }
  | { ok: false; error: GatewayGuardError };

/** The combined guard. `namespace` is the GRANTING identity's own namespace (where the node grant record
 *  lives, same as verifyExecutorAction's own first argument) -- never taken from the request's own
 *  routing/host, for the same reason every other function in this codebase resolves namespace explicitly
 *  rather than inferring it. */
export function verifyExecutorGatewayAction(
  namespace: string,
  gatewayId: string,
  input: ExecutorActionInput,
): GatewayGuardResult {
  const gw = String(gatewayId || "").trim();
  if (!gw) return { ok: false, error: "GATEWAY_ID_REQUIRED" };

  // Check 2 first (cheaper, no gateway lookup needed if this alone already fails): the node grant itself
  // -- live, unexpired, unrevoked, operation/target genuinely covered, signature verifies.
  const grantCheck = verifyExecutorAction(namespace, input);
  if (!grantCheck.ok) return { ok: false, error: grantCheck.error };

  // The grant must actually BE a gateway grant for THIS gateway -- not a plain-node grant whose opaque
  // `operations` happens to contain a string that collides with a real capability name.
  if (!nodePathCovers(`${GATEWAY_CONTROL_ROOT}.${gw}`, grantCheck.value.nodePath)) {
    return { ok: false, error: "NOT_GRANTED" };
  }

  // Check 1: the GRANTING identity's own current standing on THIS gateway, read live.
  const record = readGatewayAuthority(gw);
  const authorized = hasGatewayCapability(record, grantCheck.value.identityHash, input.operation);
  if (!authorized) return { ok: false, error: "IDENTITY_CAPABILITY_MISSING" };

  return { ok: true, identityHash: grantCheck.value.identityHash, gatewayId: gw, operation: input.operation, record: record! };
}

export interface DelegatedRevokeAdminInput {
  grantId: string;
  targetIdentityHash: string;
  nonce: string;
  timestamp: number;
  signature: string;
  signedPayload?: string;
}

export type DelegatedActionError = GatewayGuardError | GatewayAuthorityError;
export type DelegatedActionResult =
  | { ok: true; value: GatewayAuthorityRecord }
  | { ok: false; error: DelegatedActionError };

/** Check AND apply, in one call, off the one signed request -- this file's first connected operation.
 *  `namespace` is the DELEGATING identity's own namespace (whose node-grant record and keychain this
 *  executor was granted under), never the target's. */
export function revokeGatewayAdminViaNodeGrant(
  namespace: string,
  gatewayId: string,
  input: DelegatedRevokeAdminInput,
): DelegatedActionResult {
  const gw = String(gatewayId || "").trim();
  if (!gw) return { ok: false, error: "GATEWAY_ID_REQUIRED" };
  const targetIdentityHash = String(input.targetIdentityHash || "").trim();
  if (!targetIdentityHash) return { ok: false, error: "IDENTITY_MISMATCH" };

  const nodePath = `${GATEWAY_CONTROL_ROOT}.${gw}`;
  const verdict = verifyExecutorGatewayAction(namespace, gw, {
    grantId: input.grantId,
    operation: REVOKE_ADMIN_CAPABILITY,
    target: nodePath,
    // The exact mutation parameter, inside the signed payload -- a signature over "revoke identity A"
    // cannot be replayed to revoke identity B, because B was never part of what was signed.
    params: { targetIdentityHash },
    nonce: input.nonce,
    timestamp: input.timestamp,
    signature: input.signature,
    signedPayload: input.signedPayload,
  });
  if (!verdict.ok) return verdict;

  // Applied against the SAME record instance the guard just verified capability on -- no second read,
  // no gap between "authorized" and "applied" for the record to have changed underneath this decision.
  return applyGatewayAdminRevocation(verdict.record, targetIdentityHash);
}
