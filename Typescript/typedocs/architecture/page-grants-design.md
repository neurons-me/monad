# Node grants: what an executor was itself given, over which node

Design for review, revised 2026-09-22 (v3 — reframed from a gateway-specific mechanism to a general `.me`
tree mechanism, per user review). Nothing here is implemented in the sense of wired into the gateway guard;
a minimal real walkthrough of the mechanism itself is being built alongside this revision (monad branch
`feat/node-grants`) — see that branch for the actual code and tests this document now matches.

**What changed from v2, so the review is easy to re-check:** this is no longer "page grants for a gateway" —
it is grants over **any node of the `.me` tree**, of which a gateway's own control surface is one instance,
not the model. Four corrections: app and executor are separated (§2.3); the scope is a tree coordinate
(namespace + node + operations), never gateway-specific (§3); reusing structure (a personal version, an
extension) never inherits authority (§6); every signed action names its exact target, content and
replay-protection, not just "a signature" (§5).

## 1. The gap this closes, restated at the right level

`GatewayAccessContract.md` §1's rule — capabilities granted to the caller, not assumed from who is behind
it — turns out not to be gateway-specific at all. The same question applies to any app anchored to any part
of `.me`: **you** may hold full authority over your own tree; **an app you open** should hold only what you
gave it, over only the part of the tree you anchored it to. Visiting a page should never itself grant that
page anything — the owner of a gateway visiting Wikipedia does not thereby let Wikipedia restart the gateway,
and the same principle holds one level down: opening an app anchored to one node of your tree does not let
it read or write a different node, or do anything beyond the operations you actually granted.

## 2. The model

### 2.1 You stay you — this is not another login

The identity, the namespace and the session belong to the trusted `.me` runtime (`GatewayAccessContract.md`
§2), unchanged by any of this. Switching which app you're using, or which domain served it, is not
re-authentication. What a grant decides is **how much an app may do with your already-open session** — a
scope on your authority, never a second identity.

### 2.2 An app can become personal, without losing its relation to the original

Conversationally explored, recorded here because it shapes the storage model (§4) even though building it is
future work: the same authored app can be layered — the original (at a version), extensions, personal
modifications, and the namespace's own context composing into "your app running." Like tracing paper: a
layer can be toggled, compared against the original, or the original returned to without erasing what you
changed. This composes naturally on `.me` itself — the original app has its own node; your context anchors
references to it plus nodes holding your own data/changes/extensions — **not a parallel versioning system**,
relations between nodes of the same tree. What is NOT solved here: how much of that composition the runtime
already executes, and the actual mechanics of resolving "original vs. mine vs. combined." A node grant
(§3-§5) is the authorization primitive this would need, not the composition mechanism itself.

### 2.3 App and executor are two different things — correction from v2

**v2 conflated them:** a page's own generated keypair was called "the credential" as if proving possession of
it also proved *which app* was running. It doesn't. The **executor** is this one running instance — a tab, a
process — and its keypair proves only "the same running thing that made request 1 is making request 2,"
nothing about lineage or which authored app (§2.2) it claims to be. The **app** is a separate, currently
*unenforced* concept: a human-readable label recorded on the grant for the person's own benefit when
approving (§4), not a cryptographic fact this design verifies. Establishing a real, verifiable app identity
(so a grant could follow "this app" across restarts, across its own updates, or across the several origins
one app can legitimately be served from) is explicitly future work — see §7's open items. Nothing here
should be read as already solving it.

## 3. The record: a tree coordinate, not a gateway coordinate

Reserved branch under the identity's own namespace, `nodeGrants.<grantId>` — structurally next to
`keychain.keys`, following the same per-identity, semantic-memory placement:

```ts
export interface NodeGrantRecord {
  grantId: string;
  identityHash: string;        // whose tree/consent this is
  namespace: string;            // the stable namespace this grant is scoped to (normally the identity's own)
  nodePath: string;             // dot-path under that namespace; '' denotes the whole tree (allowed, not
                                 // encouraged -- nothing here forces a narrower default)
  /** What the executor may do at nodePath: 'read' | 'write' for a plain semantic node; a gateway-control
   *  node's own named capabilities (domains:write, openresty:control, ...) when nodePath denotes one --
   *  the SAME vocabulary gatewayAuthority.ts's grants already use, reused, not duplicated. A gateway is
   *  therefore just one KIND of node this mechanism can name, never a required, separate field. */
  operations: string[];
  executorPublicKey: string;    // proves "the same running instance", never "this app" (section 2.3)
  appLabel: string;             // descriptive only, shown at consent time; not cryptographically enforced
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;     // set, never deleted -- a past grant stays a real record
  nonce: string;
  signature: string;            // by the identity's own active keychain key
}
```

`gatewayId` never appears as a field. A grant whose `nodePath` happens to be `daemon.gateways.<id>` (or
whatever coordinate the gateway's own control surface resolves to) is a grant over a gateway; nothing about
the record type treats that as a special case.

## 4. Granting — approved in the trusted runtime, shown concretely

Unchanged in spirit from v2 (§4 there), restated at the general level, with the example that made it
concrete:

> An app asks: "I want to read your services and be able to restart this gateway." The runtime lets you
> approve, precisely: "You may read this gateway's services, but not restart it." Even the owner, who
> personally could restart it, has not thereby let the app do it without that grant.

1. The executor generates its own keypair and **requests** — namespace, node, operations, for how long, and
   the `appLabel` it wants shown. It cannot assert it already has any of this.
2. The runtime shows something concrete, not a generic prompt: *"`appLabel` is requesting to read this node
   of your namespace"* — naming the actual node and operations, not a vague "wants access". The identity
   approves, denies, or narrows to a subset.
3. On approval, the runtime constructs and signs a `NodeGrantRecord` with an active keychain key (the same
   vigencia check every mutation in this codebase already requires) and persists it.
4. The executor receives back enough to use the grant later, never the identity's own signing material.

The exact transport for steps 1-2 (how a page reaches the runtime across origins) stays the next, separate
design increment (unchanged from v2 §8) — naming the requirement precisely here, not the UI/wire mechanics,
to avoid stacking another abstraction before this one is reviewed.

## 5. Every signed action names its exact target and content — not just "a signature"

**Correction from v2, which said "sign a fresh payload" without specifying its shape precisely enough to rule
out reuse.** An executor performing an action signs exactly:

```json
{ "op": "node-grant-act", "grantId": "...", "namespace": "...", "nodePath": "...",
  "operation": "read", "target": "dashboard.status", "params": null,
  "nonce": "...", "timestamp": 1234567890 }
```

verified the same way every other write in this codebase already is
(`isNamespaceWriteAuthorized`'s canonicalization, against `record.executorPublicKey`), with the SAME
nonce/timestamp replay window `gatewayAuthority.ts` already uses. Binding `operation`, `target` and `params`
into what is actually signed means a signature obtained for a `read` of one path cannot be replayed as a
`write`, and a signature for one node cannot be replayed against another — the `op` discriminator convention
`keychain.ts`'s own header already explains ("a signature valid for one keychain operation can never be
replayed as a different one, even when the rest of the fields happen to coincide") applied here.

Checked, in order, before any action runs: the grant exists and is not revoked/expired; `operation` is in
`record.operations`; `target` is `nodePath` itself or a genuine sub-path of it (the SAME prefix-safety
`semanticBranchReader.test.ts` already tests for — `"dashboard"` must not match `"dashboardX"`); the
signature verifies against `record.executorPublicKey` over exactly that payload.

## 6. Reusing structure never inherits authority

**Correction from v2** (which didn't address this at all): §2.2's layering — a personal version referencing
the original, an extension building on either — is a *structural* relation (this node points at / derives
from that node), never an *authority* one. A grant is never implied by a reference. If your own version of an
app references the original app's node, and you install an extension that references your version, the
extension holds **no capability at all** until it is separately granted one — reading or acting through
either reference still goes through §5's check against the extension's OWN grant, not something inherited by
being "built on top." This is a principle to hold future layering work to, not something with more surface
area to implement in the minimal walkthrough (§8) — there is nothing to copy or extend yet.

## 7. What this does not solve

Unchanged from v2 except as noted:

- The consent-screen transport/UI (§4).
- Proving possession on a live channel (e.g. a WebSocket) that carries no credential today — revocation
  reaching an open connection's live subscriptions still needs that channel to carry `executorPublicKey`
  and a fresh signature per message, same as v2's §7 already named for `/nrp`.
- A verifiable **app identity** (§2.3) distinct from the executor — needed for §2.2's fuller vision (an app
  followed across restarts/updates/several origins) and left explicitly unbuilt.
- Vault B / no local runtime, non-browser callers with no runtime relationship at all — same as v2.
- Selling or distributing apps/extensions, and their licensing — named in the conversation that shaped this
  revision, not a question this design (an authorization primitive) answers.
- Wiring this to the gateway's own access guard (`GatewayAccessContract.md` §9) — deliberately sequenced
  AFTER the minimal walkthrough below is real and tested, not in parallel with it.

## 8. Order: prove the mechanism on a plain node first, then use it for a gateway

Per explicit instruction: demonstrate a real grant over a `.me` node before connecting anything to the
gateway guard.

1. A real monad, a real identity with a claimed namespace and an active keychain key.
2. An executor keypair, granted `operations: ['read']` over one specific node.
3. The executor reads that node — succeeds.
4. The executor attempts to `write` the same node — refused (operation not granted).
5. The executor attempts to `read` a *different* node — refused (outside `nodePath`).
6. The identity revokes the grant.
7. The executor repeats the same read that succeeded in step 3 — refused, immediately (no separate
   invalidation step needed; §5's check reads the live record on every action).

Only once this is real and passing does connecting it to `daemon.gateways.<gatewayId>` (a grant whose
`nodePath` names a gateway's own control surface, `operations` drawn from its named capabilities) become the
next step — and even then, gated on `gatewayCapabilities.ts`'s own identity-level check ALSO passing (the
`AND` from `GatewayAccessContract.md` §9's correction: the identity must hold the capability too, a node
grant alone is not enough there).
