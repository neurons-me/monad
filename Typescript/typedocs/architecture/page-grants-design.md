# Page grants: what a caller was itself given

Design for review, 2026-09-22. Nothing here is implemented. Companion to
[GatewayAccessContract.md](https://github.com/neurons-me/netget/blob/design/gateway-access-contract/Typescript/docs/GatewayAccessContract.md)
§9 and to `identity-vault-design.md` (branch `design/identity-vault`), which this depends on for how a page
gets a signing capability at all.

## 1. The gap this closes

`GatewayAccessContract.md` §1's rule:

> Same proven identity, path, operation, state **and capabilities granted to the caller** → same result.

`gatewayCapabilities.ts`'s `capabilitiesOf`/`hasGatewayCapability` (monad branch `feat/gateway-capabilities`)
answers the first half: what an **identity** holds on a gateway, from `daemon.gateways.<gatewayId>`'s
signed `owner`/`admins`/`grants`. Its own header says so directly: *"necessary, not sufficient... the owner's
'all' describes the owner's own standing, never a license for every caller claiming to act on the owner's
behalf."* Nothing today answers the second half: of what an identity holds, what did it give to the specific
**page or program** making THIS request. A route guard built on `hasGatewayCapability` alone still lets any
page that can get the owner to sign something act with the owner's full authority.

## 2. Two decisions, and why

### 2.1 The grant lives with the identity, not with the gateway

`daemon.gateways.<gatewayId>` is deliberately **installation-scoped**, "not nested under any one identity's
`users.<handle>` tree" (`gatewayAuthority.ts`'s own header) — it is the *institution's* record of who may act
on it. A page grant is the opposite kind of fact: it is the *person's* own consent to a piece of software,
independent of which gateway that software later happens to use it against. It belongs with the identity, the
same way `keychain.keys` already does (a per-namespace branch, `keychain.*`, reserved and write-guarded the
same way — see `keychain.ts`'s own header on why a keychain key's own scope is kept narrow and checked by
whichever OTHER system relies on it, never pre-declared by the keychain itself). Page grants follow that same
layering: a fourth, independent question, checked by whoever needs it, never folded into the keychain or the
gateway record.

### 2.2 What identifies "the page", for v1: its origin — with a named limit

The only thing a server can verify about which page is calling, today, is its **origin** (scheme + host +
port), via the browser-enforced `Origin` header — the same fact `originGuard`/CORS already checks
(`GatewayAccessContract.md` §3: origin validation "stops another site's page from using a grant; it never
grants" — this design is what actually grants).

This has a real gap, worth stating rather than hiding: this session's own model (§8) treats **the document**
(the app) as authored and fixed, while it can legitimately be *served from more than one origin* —
`netget.site`, `local.netget`, this machine's own hostname are, per that model, "the same app". Granting by
raw origin means the person must grant each origin separately even though they think of it as one app.
Granting by a verifiable **app identity** instead (a signed manifest identifying the document itself,
independent of which origin serves it) would match the model better, but no such mechanism exists yet —
building one is real, separate work (a document would need to prove *what it is*, not just *where it came
from*). **v1 grants by origin**, and documents this as the open question it is (§8 below), rather than
quietly picking the more elegant answer before its prerequisite exists.

A second, already-acknowledged limit carries over unchanged from `identity-vault-design.md`: an origin
allow-list restricts the *legitimate* client; it does not stop a malicious page serving its own JS from a
*compromised* origin from exercising whatever that origin was granted. Phishing resistance still lives
outside this protocol.

## 3. The record

New reserved branch under the identity's own namespace, `pageGrants.<gatewayId>.<originKey>`, structurally
next to `keychain.keys` (same per-identity, semantic-memory-backed placement):

```ts
export interface PageGrantRecord {
  identityHash: string;        // whose consent this is
  gatewayId: string;           // which gateway's capabilities this can draw from
  origin: string;               // the exact caller origin (scheme://host[:port])
  /** Opaque scope strings, same vocabulary as GatewayAuthorityRecord.grants -- a subset the identity
   *  chose to extend to this caller, never a namespace this design invents on its own. */
  scopes: string[];
  grantedAt: number;
  /** Optional; a grant with no expiry must be revocable just as easily as one that expires (section 5). */
  expiresAt: number | null;
  /** Nonce/signature bookkeeping, same shape gatewayAuthority.ts's grant/revoke already use. */
  nonce: string;
  signature: string;
}
```

`originKey` is the origin string, normalized and escaped the same way `domainStore.ts` already escapes a
domain for use as a kernel-tree key segment (dots and colons are not safe bare path segments).

## 4. The authorization question

A route's real check becomes, always, the intersection of independent layers, never a shortcut through any
one of them:

```
mayAct(identity, gatewayId, callerOrigin, capability) :=
      hasGatewayCapability(gatewayAuthorityRecordOf(gatewayId), identity, capability)   // identity holds it
  AND hasPageGrant(pageGrantRecordOf(identity, gatewayId, callerOrigin), capability)     // AND gave it to this caller
```

Never `OR`, never "the owner's page skips the second check" — an owner acting through an ungranted page has
`capabilitiesOf` = `'all'` and `pageGrantScopes` = `∅`, so `mayAct` is `false` for everything until the owner
explicitly grants that page something. A page can never end up with *more* than the identity itself holds —
`hasPageGrant` alone is not sufficient either; both sides must say yes. `pageGrantRecordOf` returns `∅` (never
throws, never assumes) when no grant exists for that exact `(identity, gatewayId, origin)` triple — a page
with no history gets nothing, the same fail-closed posture `capabilitiesOf` already has for an unrelated
identity.

## 5. Granting and revoking

Signed by the identity itself, the same conventions `gatewayAuthority.ts`'s `grantGatewayAdmin`/
`revokeGatewayAdmin` already use (a canonicalized, nonce-bearing payload verified through
`isNamespaceWriteAuthorized`, replay-rejected the same way): `op: "page-grant"` / `op: "page-grant-revoke"`,
signed with an **active keychain key** for that identity (vigencia, checked fresh — never cached — the same
way every other mutation in this codebase already is).

Two usability questions this raises, left open rather than guessed (section 8):

- **Where does the grant UI live?** A person needs to see "this page is asking to act as me for
  `domains:write`" and approve or deny it — an actual consent screen, analogous to an OAuth authorization
  page. Nothing today shows this.
- **Can a page request its own grant, or must the identity always initiate it from elsewhere?** A page
  asking "please grant me X" and the person approving in-context is the more usable flow (closer to OAuth);
  the identity pre-declaring grants for pages it hasn't even loaded yet is more auditable but less
  ergonomic. Not decided here.

## 6. How this changes an admin session

Today, `resolveAdminSession`'s issued session token carries `{identityHash, scopes}`, with `scopes` filled
from `GatewayAuthorityRecord.grants[identityHash]` at issue time — i.e. the *identity's* capabilities, baked
into the token, with no notion of which page requested the session at all.

Two ways to add the page-grant check; the cleaner one:

- **Compute live, at every check, not baked into the token.** The session continues to prove *identity*
  (vigencia + autorización, unchanged); the requesting page's `Origin` is read fresh on each protected
  request, exactly as `originGuard` already does, and `hasPageGrant` is evaluated at THAT moment against the
  current record. This matches the codebase's existing preference for fresh, uncached authorization checks
  (the admin-session revocation test already proves a revoked identity is rejected on its very next use, not
  merely "eventually" — a page-grant revocation should have the identical guarantee) and needs no session
  format change at all: `adminGate.mjs` gains a second check alongside `hasGatewayCapability`, not a new kind
  of token.
- Baking the intersection into the session at issue time was considered and rejected: it would make a grant
  revocation NOT take effect until the session's own token expired or was separately invalidated, breaking
  the "next use" guarantee the identity-level revocation already has.

## 7. Interaction with the document/namespace model (§8)

A page's grants are keyed to `(identity, gatewayId, origin)` — not to "the document" as an abstract app, and
not automatically carried when the SAME document connects to a DIFFERENT namespace/gateway at runtime
(§8's own "namespace as a person-changeable runtime parameter", not built yet). This is deliberate and
already named in §8's own words: **"elegir B no concede acceso automáticamente: se aplican sus permisos"** —
connecting to gateway B starts that page with whatever B's own grants say, never inherited from A. A page
that legitimately needs standing capabilities on several gateways needs a separate grant on each.

## 8. Explicitly out of scope here

- **The consent UI** and **who initiates a grant** (section 5) — a real, separate piece of work.
- **App identity instead of raw origin** (section 2.2) — needs a verifiable "what this document is" fact
  that does not exist yet; noted as the more correct long-term answer, not built.
- **Vault B / no local runtime** (`GatewayAccessContract.md` §2's own table) — a page grant assumes the
  identity's local runtime is already available to sign it; recovering a session on a device with no prior
  history is a separate mechanism.
- **Non-browser callers** (a CLI, a script) — `Origin` does not exist for those; they need their own caller
  identity, likely closer to section 4 of `GatewayAccessContract.md` (the machine as a real identity with its
  OWN grants) than to this page-origin model. Worth reconciling later, not attempted here.
- **Wiring this into `adminGate.mjs` or any route** — this document defines the shape and the check; nothing
  is implemented, per the explicit ask that this be reviewed before any of that starts.

## 9. Open decisions

1. Origin-scoped grants (v1, this design) vs. app-identity-scoped grants (needs new infrastructure) — which
   to build, or build the former now with a migration path to the latter later.
2. The consent UI and initiation flow (section 5).
3. Expiring grants by default, or only on request — an unexpired-forever grant is simpler but a standing
   risk if a page is later compromised; an expiring one is safer but adds re-consent friction.
4. Whether a revoked/expired page grant should also proactively invalidate any admin-session token already
   issued through it, or whether the live intersection check (section 6) alone is enough (it is enough for
   correctness — a revoked page immediately fails the next protected call — but the identity-level precedent
   also actively tears down sessions on revocation, worth matching for consistency, not required for safety).
