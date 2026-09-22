/**
 * gatewayCapabilities.ts -- what an IDENTITY holds on this gateway, consulting gatewayAuthority.ts's
 * own tree-backed record (`daemon.gateways.<gatewayId>`, never a second, hand-maintained list) --
 * see GatewayAccessContract.md §1/§4.
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
 *
 * NECESSARY, NOT SUFFICIENT (correction, 2026-09-22, user review): this only answers what the IDENTITY
 * holds on the gateway. Section 1's rule is "capabilities granted to the CALLER" -- the page or program
 * actually making the request -- and a page acting nominally "as" an identity does not thereby inherit
 * everything that identity holds; it holds only what THAT IDENTITY granted THAT PAGE. `'all'` for the
 * owner describes the owner's own standing, never a license for every caller claiming to act on the
 * owner's behalf. That second, caller-level grant is a SEPARATE mechanism this file does not provide --
 * it belongs with the runtime/session work section 2 already defers to (a page only has what was
 * granted to it, never assumed from who is behind it) -- so a real route guard built on
 * `hasGatewayCapability` alone is still incomplete until that layer exists too.
 */
import type { GatewayAuthorityRecord } from "./gatewayAuthority.js";

/** Every capability the IDENTITY holds on this gateway: the literal set from `grants`, or `'all'` for
 *  the owner. Never partial for the owner -- an owner is not just another admin with a long grant
 *  list. Says nothing about what a given CALLER acting as this identity was itself granted -- see this
 *  file's own header. */
export function capabilitiesOf(record: GatewayAuthorityRecord | null | undefined, identityHash: string): Set<string> | "all" {
  const id = String(identityHash || "").trim();
  if (!record || !id) return new Set();
  if (record.owner === id) return "all";
  if (record.admins[id] !== true) return new Set();
  return new Set(record.grants[id] ?? []);
}

/** Does the IDENTITY currently hold `capability` on this gateway -- necessary for a route's own
 *  authorization check, not sufficient on its own (this file's header: says nothing about whether the
 *  CALLER making this particular request was itself granted that capability by the identity). */
export function hasGatewayCapability(
  record: GatewayAuthorityRecord | null | undefined,
  identityHash: string,
  capability: string,
): boolean {
  const caps = capabilitiesOf(record, identityHash);
  return caps === "all" || caps.has(capability);
}
