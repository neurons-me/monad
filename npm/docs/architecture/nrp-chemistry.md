# NRP Chemistry — Settled Architecture

> Frozen 2026-05-07. Tag: `nrp-chemistry-v0.1`
> Updated 2026-05-07: compound surface syntax + Groups primitive settled

---

## Core Primitives

### `.me` — Local Sovereign Continuity

```ts
const me = new Me();
me("ana", "secret")   // compound seed = keccak256("me.seed/compound:v1::ana::secret")
                       // expression = "ana", identityHash deterministic
me("ana")             // setActiveExpression only — no reseed
```

`.me` is not a server. It is not a tenant. It is the kernel — a sovereign computational
identity that works offline, without network, without any external service.
If everything else disappears, `.me` still computes.

### `cleaker` — Claim Resolver

```ts
cleaker(me)                    // surface = cleaker.me, namespace = "ana.cleaker.me"
cleaker(me, "space")           // explicit surface
cleaker(me, "sui-macbook.local") // private/LAN surface
```

`cleaker` binds a `.me` identity to a namespace surface. It is the resolver —
it answers "where does this identity live in the network?"
`cleaker.me` is the default public rootspace. It is a verification surface, not a cloud.

### `namespace` — Semantic Surface

```
cleaker.me              rootspace (no prefix, public)
suign.cleaker.me        user compound (personal namespace)
sui-macbook.local       private/LAN surface
neurons.me              independent rootspace
```

The namespace is not storage. The namespace is chemistry.
It is the surface where identities react and compounds form.

**Layer separation (canonical):**

```
.me           → knowledge graph. sovereign, offline, individual.
               Expresses relational/existential conditions. Works without any surface.
cleaker       → projection. binds .me to a surface context.
NRP grammar   → the language of contexts. surfaces, audiences, groups.
monad.ai      → execution. runs the graph over HTTP, registers on the mesh.
```

`.me` is for expressing a relational existential condition — a knowledge graph.
The namespace is the *sentence* where that graph speaks and reacts with others.
You don't write a book in one expression.

Two surface types:
- **Rootspace**: `cleaker.me` — no prefix, open, verifiable via DNS
- **Compound**: `suign.cleaker.me` — user prefix + rootspace constant

---

## Routing Primitives

### `monad[name]` — Scoped Monad Resolution

```
me://suign.cleaker.me:read/monad[frank]/projects/x
```

`monad[frank]` is NOT a fixed server or isolated AI instance.
It is a named claimant traversing namespace scopes via a fallback chain:

```
1. frank @ suign.cleaker.me   (compound — exact match)
2. frank @ cleaker.me         (rootspace — fallback)
3. 404
```

Same semantic name. Different contextual projections. One identity.

This mirrors: JS prototype chain · CSS cascade · lexical scope · DNS fallback.

The bridge extracts `monadId = "frank"` and `monadScopePath = "projects/x"`,
runs `selectMeshClaimantByScope`, then proxies to frank's endpoint at `/projects/x`
(not at `/monad[frank]/projects/x`).

### `surface[]` — Mesh Resolver

```
cleaker.me[]          public mesh — all monads registered to this surface
sui-macbook.local[]   private/LAN mesh
raspberry.local[]     device-level mesh
```

`surface[]` means: ask that surface's `/.mesh/monads` for registered claimants,
use the result as the candidate pool instead of the local index.

Priority order for surface resolution:
```
1. local processes first
2. LAN / .local
3. trusted mirrors
4. public surface (cleaker.me)
```

### `surface[a+b]` — Compound / Audience Surface

```
cleaker.me[ana+frank]             audience compound anchored to public rootspace
sui-macbook.local[ana+frank]      same audience on a private LAN surface
suign.cleaker.me[ana+frank]       compound on a user namespace
```

`surface[a+b]` is NRP syntax for a **multi-party audience namespace**. It lives entirely
in the NRP / cleaker layer — not in `.me`. The bracket notation is consistent with:

```
surface[]             → mesh resolver (all monads)
surface[frank]        → named monad (scope-chain routing) — in path, not surface
surface[ana+frank]    → audience compound (multi-party shared namespace)
```

**Layer separation:**

```
.me                   → seed / kernel / who — pure, offline, no social chemistry
cleaker / NRP         → surface projection, compound resolution, audience derivation
monad.ai              → execution mesh, HTTP surface
```

`.me` is intentionally kept minimal. Audience chemistry belongs to the NRP layer
because it is about *surfaces and resolution*, not about *who you are*.

### `group:name` — Stable Group Surface

```
group:neuroverse
cleaker.me[group:neuroverse]
suign.cleaker.me[group:team]
sui-macbook.local[group:family]
```

A group is a **stable namespace with dynamic membership**. The namespace never changes
when members enter or leave. The group has its own kernel — a `.me` graph that holds:

```
members[]          current member list
invites[]          pending invitations
revocations[]      removed members
admins[]           who can change membership
membership proofs  cryptographic signatures confirming membership
```

Once the group namespace is open, all paths inside it are normal NRP paths:

```
cleaker.me[group:neuroverse]/vision/roadmap
cleaker.me[group:neuroverse]/monad[frank]/status
cleaker.me[group:neuroverse]/members
cleaker.me[group:neuroverse]/monad[memory]
```

---

## Audiences vs Groups — The Full Distinction

| | Audience `surface[a+b]` | Group `group:name` |
|---|---|---|
| Namespace stability | Destructive — changes if membership changes | Stable — never changes |
| Membership | Exactly the set of seeds, cryptographically bound | Dynamic — enter and leave freely |
| Derivation | `keccak256(sorted seeds)` — no server | Claim-based — group has its own kernel |
| Scale | 2–5 people (trust is mathematical) | Unlimited (trust is credential-based) |
| Use case | Shared secrets, private channels, encrypted bilateral | Teams, communities, projects, circles |
| Scoping rule | Always defines the full namespace root | Always defines the full namespace root |

**Rule:** both `surface[a+b]` and `group:name` always define the **entire namespace**.
They are never embedded in the middle of a path. Everything after `]` is a path inside the context.

```
✅  cleaker.me[group:neuroverse]/projects/ai
✅  cleaker.me[ana+frank]/memories
❌  cleaker.me/projects[group:ai]   ← invalid — group must be at namespace root level
```

This keeps the parser simple and the semantics consistent with `monad[frank]` and `surface[]`.

---

## Mesh Registration

### `MONAD_SURFACE_URL` — Announce Target

```bash
MONAD_SURFACE_URL=https://cleaker.me      # public mesh
MONAD_SURFACE_URL=http://sui-macbook.local:8161  # private LAN mesh
# (unset) = local-only mode, invisible to any external surface
```

On startup and every 30s (configurable via `MONAD_ANNOUNCE_INTERVAL_MS`),
the monad POSTs its `MonadIndexEntry` to `MONAD_SURFACE_URL/.mesh/announce`.

### `POST /.mesh/announce`

Any monad can register on any surface:

```json
{
  "monad_id": "monad:abc123",
  "name": "frank",
  "namespace": "suign.cleaker.me",
  "endpoint": "http://raspberry.local:8161",
  "claimed_namespaces": ["suign.cleaker.me"],
  "tags": ["raspberry", "sensor"],
  "scope_path": "/projects/music"
}
```

Surfaces throttle repeated announces (10s minimum between accepts).
Entries go stale after `DEFAULT_STALE_MS` (5 min) if heartbeat stops.

---

## Cryptographic Set-Chemistry on Audiences

A single party derives a personal compound via `.me`:
```
me("frank", "secret") → compound_seed → { kernel, keypair, namespace }
```

Multiple parties derive a shared audience namespace via NRP surface syntax:
```
surface[ana+frank]

audienceSeed = keccak256("me.seed/audience:v1::" + sort([seed1, seed2]).join("::"))
```

The `+` in `surface[ana+frank]` is NRP grammar, not a method on `.me`.
`cleaker` resolves it by sorting the member seeds, hashing, and deriving the namespace.

Properties:
- `ana+frank` = `frank+ana` (commutative — sorted before hashing)
- `ana+frank+luna` → different namespace than `ana+frank`
- Remove any party → namespace no longer derivable
- No server. No registry. Exists only where the exact seed set is present.

### KDF Domain Separation (planned)

```
compound_seed = keccak256("me.seed/compound:v1::" + who + "::" + secret)
kernelSeed    = HKDF(compound_seed, info="this.me/kernel/v1")
ed25519Seed   = HKDF(compound_seed, info="monad.ai/ed25519/v1")
```

Compromise of one domain does not compromise the other.
Same `(who, secret)` → same monad everywhere → resolves namespace ambiguity in scope chain.

---

## Deployment Topologies

### Private (local only)
```bash
# No MONAD_SURFACE_URL set
# Monads visible only to same-machine siblings via CLI record store
cleaker(me, "sui-macbook.local")
→ resolves: suign.sui-macbook.local
```

### Personal mesh (LAN)
```bash
MONAD_SURFACE_URL=http://sui-macbook.local:8161
# Raspberry, iPhone, other devices announce to Mac
# cleaker(me, "sui-macbook.local[]") resolves across all LAN devices
```

### Community namespace
```bash
MONAD_SURFACE_URL=https://cleaker.me
# Monad appears in public directory
# Namespace owner controls: traffic rules, billing, access policies
# Anyone can put monads at service of a namespace — donate or charge
```

### Audience-private
```
cleaker.me[ana+suign]/monad[memory]
→ compound namespace only ana+suign can derive
→ memory monad serves only that audience
→ invisible to all others by construction
```

Note: `surface[a+b]` is NRP grammar resolved by `cleaker`.
The audience chemistry lives in the resolution layer, not in `.me`.

---

## Monad Economy

```
namespace owner   → sets rules, controls traffic, can bill, can block
monad provider    → registers monads, donates or charges compute resources
.me user          → sovereign identity, works without any surface
```

The namespace is the market. Monads are the compute.
The mesh is the marketplace where they meet.

---

## Implementation Status (2026-05-07)

| Primitive | Status | Location |
|---|---|---|
| `me(who, secret)` compound seed | ✅ | `this.me/npm/src/me.ts` |
| `cleaker(me)` default to cleaker.me | ✅ | `cleaker/npm/src/binder.ts` |
| `monad[frank]` scope chain routing | ✅ | `monad/npm/src/runtime/bridge.ts` + `meshSelect.ts` |
| `POST /.mesh/announce` incoming | ✅ | `monad/npm/src/http/meshAnnounce.ts` |
| `MONAD_SURFACE_URL` outgoing announce | ✅ | `monad/npm/src/index.ts` |
| `namespace:fallback` / `namespace:failed` events | ✅ | `cleaker/npm/src/binder.ts` |
| KDF domain separation | 🔲 planned | monad × me identity unification |
| `surface[]` mesh resolver in bridge | 🔲 planned | `bridge.ts` + `bridgeHandler.ts` |
| `surface[a+b]` audience compound resolver | 🔲 planned | `cleaker/npm/src/` (NRP layer, not `.me`) |
| `group:name` stable group namespace | 🔲 planned | `cleaker/npm/src/` + monad kernel for group |

**Layer contract (permanent):**
- `.me` = sovereign knowledge graph. Offline, individual, relational. No social chemistry.
- `cleaker / NRP` = grammar of contexts. Surfaces, audiences (`surface[a+b]`), groups (`group:name`).
- `monad.ai` = execution and mesh.

**Test coverage: 270+ tests / 24+ files — all green.**
