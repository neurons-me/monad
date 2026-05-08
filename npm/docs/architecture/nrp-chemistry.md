# NRP Chemistry — Settled Architecture

> Frozen 2026-05-07. Tag: `nrp-chemistry-v0.1`

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

Two namespaces:
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

### `[]` — Mesh Resolver

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

A single party derives a personal compound:
```
me("frank", "secret") → compound_seed → { kernel, keypair, namespace }
```

Multiple parties derive a shared audience namespace:
```
audienceSeed = keccak256("me.seed/audience:v1::" + sort([seed1, seed2]).join("::"))
```

Properties:
- `frank + ana` = `ana + frank` (commutative — sorted before hashing)
- `frank + ana + luna` → different compound than `frank + ana`
- Remove any party → namespace no longer resolvable
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
audience[ana+suign].cleaker.me/monad[memory]
→ compound namespace only ana+suign can derive
→ memory monad serves only that audience
→ invisible to all others by construction
```

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
| KDF domain separation | 🔲 planned | monad × me identity unification |
| `surface[]` mesh resolver in bridge | 🔲 planned | `bridge.ts` + `bridgeHandler.ts` |
| Audience compound `me.compound(...others)` | 🔲 planned | `this.me/npm/src/me.ts` |

**Test coverage: 270 tests / 24 files — all green.**
