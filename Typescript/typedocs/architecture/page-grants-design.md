# Page grants: what a caller was itself given

Design for review, revised 2026-09-22 (v2, after the first round's review). Nothing here is implemented.
Companion to
[GatewayAccessContract.md](https://github.com/neurons-me/netget/blob/design/gateway-access-contract/Typescript/docs/GatewayAccessContract.md)
§9 and to `identity-vault-design.md` (branch `design/identity-vault`), whose "local runtime" is where the
consent step below actually runs.

**What changed from v1**, so the review is easy to re-check: the consent flow is now the core mechanism, not
an open question (§4); the grant is bound to a credential the caller proves possession of, not to `Origin`
alone (§2.2, §5); the record carries an explicit scope shape — caller, resource, capabilities, and node when
relevant (§3); revocation is specified to cover HTTP, WebSocket actions, and live subscriptions, not just a
session's visible state (§7).

## 1. The gap this closes

`GatewayAccessContract.md` §1's rule:

> Same proven identity, path, operation, state **and capabilities granted to the caller** → same result.

`gatewayCapabilities.ts`'s `capabilitiesOf`/`hasGatewayCapability` (monad branch `feat/gateway-capabilities`)
answers the first half: what an **identity** holds on a gateway. Its own header: *"necessary, not
sufficient... the owner's 'all' describes the owner's own standing, never a license for every caller
claiming to act on the owner's behalf."* This design is the second half: of what an identity holds, what did
it give to the specific **page or program** making THIS request — proven, not merely asserted by a header a
caller controls.

## 2. Two decisions, and why

### 2.1 The grant lives with the identity, not with the gateway

Unchanged from v1: `daemon.gateways.<gatewayId>` is installation-scoped (`gatewayAuthority.ts`'s own header:
"not nested under any one identity's `users.<handle>` tree"). A page grant is the person's own consent to a
piece of software, independent of which gateway it later uses that consent against — it belongs with the
identity, structurally next to `keychain.keys` (a per-namespace, reserved, independently-checked branch, the
same layering `keychain.ts`'s own header already establishes: a narrow fact, checked by whoever relies on it,
never pre-declared).

### 2.2 The caller is identified by a credential it proves possession of — `Origin` is not that credential

**Correction from v1, which bound the grant to `Origin` directly.** `Origin` is a header the BROWSER sets and
enforces for a real cross-origin fetch — useful as an *additional*, defense-in-depth check that stops another
site's page from silently reusing a grant. It is not proof of identity: any non-browser HTTP client can send
whatever `Origin` value it likes, and nothing about the header itself is signed or otherwise unforgeable.
Binding a grant to it alone would let anyone who can send an HTTP request with the right header claim it.

The caller instead needs to **prove possession of a private key**, the same primitive `keychain.ts` already
uses for a person's own devices, applied here to a page/program instead: when consent is granted (§4), the
result is a record keyed by a **public key the caller generated itself** (an ephemeral Ed25519 keypair, via
WebCrypto in the page's own JS — the private half never leaves the page, never crosses to the runtime).
Every later request signs a fresh, nonce-bearing payload with that same key, verified the same way every
other write in this codebase already is (`isNamespaceWriteAuthorized`'s canonicalization). `Origin` is then
checked *as well* — a real, useful second lock — but the grant's real identity is the key, not the header.

**v1 simplification, explicit rather than assumed:** bind the issued credential ALSO to the approved origin
at grant time — a signature from the right key but a different `Origin` than the one recorded is refused.
Changing origin then needs a new approval. This does not mean re-authenticating to `.me`: authenticating (who
you are) and granting a page access (what it may do) stay separate, as they already are today — the
identity's own session in the local runtime is unaffected by a page's grant being approved, refused, or later
revoked.

## 3. The record

New reserved branch under the identity's own namespace, `pageGrants.<grantId>`, next to `keychain.keys`:

```ts
export interface PageGrantRecord {
  grantId: string;              // opaque id, this grant's own key
  identityHash: string;         // whose consent this is
  callerPublicKey: string;      // the credential (§2.2) -- what proves "this exact caller" on every request
  approvedOrigin: string;       // v1 binding (§2.2); checked alongside the signature, not instead of it
  /**
   * Scope -- living under the identity does NOT mean authority over every gateway the identity can reach.
   * gatewayId is required; nodePath narrows further (GatewayAccessContract.md §7's mount reference) when
   * the grant is meant for one mounted node rather than the gateway as a whole -- omitted/'' means the
   * gateway's own root, matching how a mount reference already denotes "the whole tree from here".
   */
  gatewayId: string;
  nodePath: string;
  /** Opaque scope strings, same vocabulary as GatewayAuthorityRecord.grants -- a subset the identity chose
   *  to extend to this caller; never a namespace this design invents on its own. */
  capabilities: string[];
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;     // set, never deleted -- a past grant stays a real record, §7
  nonce: string;
  signature: string;            // by the IDENTITY (via an active keychain key) -- this is the identity's
                                 // consent record, signed the same way grantGatewayAdmin already is
}
```

`grantId` (not `origin`, per §2.2's correction) is the record's own key, so one identity can hold several
grants for the same caller public key across different `(gatewayId, nodePath)` scopes, or several distinct
caller keys for the same gateway (a person may run more than one trusted page).

## 4. The consent flow — approved in the trusted `.me` runtime, never fabricated by the page

**Core mechanism, not an open question (correction from v1's §5).** A page cannot grant itself anything and
cannot manufacture an approval; the identity's own trusted local runtime (`identity-vault-design.md`'s
runtime — where the identity is already unlocked and able to sign) is the only place a `PageGrantRecord` can
be produced, because producing one requires the identity's own signature.

The shape of the flow, at the level this design fixes (the exact transport/UI is the next, separate design
increment — named in §8, not fully specified here to avoid adding a second layer of abstraction before this
one is reviewed):

1. The page generates its own keypair (§2.2) and **requests** capabilities — which gateway, which node (if
   any), which capabilities, for how long — from the identity's trusted runtime. The request names what it
   wants; it does not and cannot assert that it already has it.
2. The runtime shows the identity a real consent screen: which page (origin, and whatever else can be shown
   honestly — see §8's note on why origin alone is a weak identity signal even for display purposes),
   requesting which capabilities, on which gateway/node, for how long. The identity approves, denies, or
   narrows the request (grants a subset).
3. On approval, the runtime constructs and signs a `PageGrantRecord` (§3) with the identity's own active
   keychain key — the same "vigencia" check (is this signing key currently active) every other mutation in
   this codebase already requires — and persists it.
4. The page receives back only what it needs to use the grant later: enough to know it was approved (and
   for what), never the identity's own signing material.

A denied or ignored request produces no record at all — the same fail-closed shape `capabilitiesOf`/
`hasPageGrant` already assume for "nothing exists here."

## 5. The authorization question

Unchanged in shape, restated with the corrected binding:

```
mayAct(identity, gatewayId, nodePath, capability, callerPublicKey, signature, requestOrigin) :=
      hasGatewayCapability(gatewayAuthorityRecordOf(gatewayId), identity, capability)        // identity holds it
  AND record := activePageGrant(identity, gatewayId, nodePath, callerPublicKey)                // a live grant for THIS key
  AND record.capabilities.includes(capability)                                                // covers this capability
  AND verifySignature(record.callerPublicKey, signature, thisRequest)                          // caller proved the key
  AND requestOrigin === record.approvedOrigin                                                  // v1 binding (§2.2)
```

Always an `AND` chain, never a shortcut through any one link — an owner acting through an ungranted page has
`capabilitiesOf` = `'all'` and no matching `activePageGrant`, so `mayAct` is `false` for everything until
explicitly granted. A page can never end up with more than the identity itself holds, since both sides must
independently say yes. No matching record (wrong key, wrong gateway/node, revoked, expired) is the same
fail-closed `∅` `capabilitiesOf` already returns for an unrelated identity — never an error, never a
different code path that could be reasoned about differently.

## 6. Granting and revoking

Granting is §4. Revoking: the identity signs `op: "page-grant-revoke"` for a `grantId`, same conventions as
`gatewayAuthority.ts`'s `revokeGatewayAdmin` (canonicalized, nonce-bearing, `isNamespaceWriteAuthorized`,
replay-rejected). The record's `revokedAt` is set, never deleted — the same "kept, not removed" shape
`gatewayAuthority.ts` doesn't currently follow for `grants` (it deletes on revoke) but which is worth
requiring HERE specifically because §7 needs to actively act on a revocation at the moment it happens, not
merely stop matching it on the next fresh read.

## 7. Revocation must stop the next authorized action everywhere, not just look revoked

**Correction from v1, which only reasoned about ordinary HTTP requests.** A closed visual session is not the
requirement; the requirement is that no FURTHER authorized action of any kind succeeds after revocation,
across every transport this codebase actually has:

- **HTTP** (`adminGate.mjs` and any future guard built on §5): already correct by construction — §5 is
  evaluated fresh on every request, reads the current record, so a revoked grant fails on its very next use,
  matching the identity-level admin-session precedent exactly (no separate work needed here).
- **WebSocket actions** (`nrpHandler.ts`'s `/nrp` channel, `attachNrpWebSocketServer`): each inbound message
  is already dispatched fresh per `handleMessage` call (confirmed: no per-connection auth cached across
  messages today) — a §5 check per action-requiring message closes this the same way as HTTP, PROVIDED the
  message carries (or the connection was opened with) the caller's signature/key the same way an HTTP request
  would. Not true automatically: today's `/nrp` connections carry no such proof at all (open item, §8).
- **Live subscriptions** (`nrpHandler.ts`'s `connectionSubs`, a path → unsubscribe map per WebSocket): this is
  the genuinely new requirement. A subscription opened under a since-revoked grant must be **actively torn
  down**, not merely left to keep delivering updates until the socket happens to close. Concretely: a
  subscription must be registered keyed by (or alongside) the `PageGrantRecord.grantId` that authorized it,
  and revoking that grant must walk every live subscription opened under it and call its own `unsubscribe()`
  immediately — the same registry `attachNrpWebSocketServer`'s own `close` handler already uses for the
  unrelated case of the socket itself closing, generalized to fire on a grant's revocation too, not only on
  disconnect. The socket itself need not close; only the subscriptions that depended on the now-gone grant
  do, and the caller should be told why (a distinct error/notice, not silence) rather than simply stop
  hearing updates with no explanation.

## 8. Explicitly out of scope here

- **The exact consent-screen transport and UI** (§4's step 2) — cross-origin communication between a
  requesting page and the identity's trusted runtime (a redirect flow, a signed postMessage exchange, a
  popup — each has real trade-offs) is its own design, not fixed here to avoid adding a second abstraction
  layer before this one is reviewed. What IS fixed: the runtime alone produces the signed record; the page
  never does.
- **Proving possession on the `/nrp` WebSocket channel** — today's connections carry no signature at all;
  wiring §7's WS/subscription revocation in requires that channel to carry a caller credential first, a
  concrete follow-up, not assumed to already exist.
- **App-identity credentials as a replacement for the origin binding** (§2.2's v1 simplification) — the
  caller's OWN generated keypair already is a real, unforgeable identity per grant; what remains open is
  whether one such key could legitimately represent "the same app" across several origins (this session's
  own document/namespace model, §8 of the contract) without a separate grant per origin. Not solved here.
- **Vault B / no local runtime** — a page grant assumes the identity's local runtime is already available to
  sign it in §4; recovering on a device with no prior history is a separate mechanism.
- **Non-browser callers with no page/runtime relationship at all** (a bare CLI or script never mediated by
  any `.me` runtime) — likely closer to `GatewayAccessContract.md` §4's machine identity than to this design;
  not reconciled here.
- **Wiring this into `adminGate.mjs` or any route** — unchanged from v1: this document defines the shape and
  the checks; nothing is implemented.

## 9. Open decisions

1. The consent-screen transport (§8) — which mechanism, concretely.
2. Whether `capabilities: string[]` should be constrained to a real, shared vocabulary now (matching
   whatever the per-route capability table under `GatewayAccessContract.md` §9 ends up naming) or stay
   opaque strings until that table exists.
3. Grant lifetime defaults: `expiresAt` always required vs. optional standing grants, and the renewal UX for
   an expiring one.
4. One caller key representing "the same app" across several origins (§8) vs. a strictly per-origin key —
   depends on the still-nonexistent app-identity mechanism this session's document/namespace model would
   need for its own equivalence claim to fully hold.
