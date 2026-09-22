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
 * Returns an authorization VERDICT only -- it does not perform grantGatewayAdmin/revokeGatewayAdmin/
 * transferGatewayOwner or any other gateway effect on the executor's behalf. Wiring an executor-driven
 * call to actually perform one of those actions is a separate, later step; this is the gate in front of
 * it, built and proven first.
 */
import { verifyExecutorAction, nodePathCovers, type ExecutorActionInput, type ExecutorActionError } from "./nodeGrants.js";
import { readGatewayAuthority } from "./gatewayAuthority.js";
import { hasGatewayCapability } from "./gatewayCapabilities.js";

const GATEWAY_CONTROL_ROOT = "daemon.gateways";

export type GatewayGuardError = ExecutorActionError | "GATEWAY_ID_REQUIRED" | "IDENTITY_CAPABILITY_MISSING";

export type GatewayGuardResult =
  | { ok: true; identityHash: string; gatewayId: string; operation: string }
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

  return { ok: true, identityHash: grantCheck.value.identityHash, gatewayId: gw, operation: input.operation };
}
