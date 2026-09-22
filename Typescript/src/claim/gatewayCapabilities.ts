/**
 * gatewayCapabilities.ts -- the single check of "what may this identity do to this gateway",
 * consulting gatewayAuthority.ts's own tree-backed record (`daemon.gateways.<gatewayId>`, never a
 * second, hand-maintained list) -- see GatewayAccessContract.md §1/§4.
 *
 * The record already carries this: `admins` (who currently holds authority) and `grants` (opaque
 * scope strings per identity -- "never a netget-specific type", gatewayAuthority.ts's own words) are
 * real, signed, tested state, not something this file invents. What was missing is a shared way to
 * ask it a capability question instead of every caller re-deriving its own notion of "authorized"
 * (adminGate.mjs's own single coarse `gateway:write` scope is exactly that re-derivation, and Lua's
 * loopback-only check is a second, unrelated one -- this file is the piece both should end up calling
 * instead, once routes are reclassified onto named capabilities and Lua stops deciding on its own;
 * that reclassification and the Lua→monad redirect are NOT done by this file alone).
 *
 * The owner's authority is unconditional and never expressed as entries in `grants` --
 * bootstrapGatewayAuthority leaves the owner's own grants array empty; `admins[identityHash] === true`
 * with no matching `grants` entry means "authorized, but for nothing named yet", never "owner-like".
 */
import type { GatewayAuthorityRecord } from "./gatewayAuthority.js";

/** Every capability an identity holds: the literal set from `grants`, or `'all'` for the owner. Never
 *  partial for the owner -- an owner is not just another admin with a long grant list. */
export function capabilitiesOf(record: GatewayAuthorityRecord | null | undefined, identityHash: string): Set<string> | "all" {
  const id = String(identityHash || "").trim();
  if (!record || !id) return new Set();
  if (record.owner === id) return "all";
  if (record.admins[id] !== true) return new Set();
  return new Set(record.grants[id] ?? []);
}

/** Does this identity currently hold `capability` on this gateway -- the one question every route's
 *  own authorization check should reduce to. */
export function hasGatewayCapability(
  record: GatewayAuthorityRecord | null | undefined,
  identityHash: string,
  capability: string,
): boolean {
  const caps = capabilitiesOf(record, identityHash);
  return caps === "all" || caps.has(capability);
}
