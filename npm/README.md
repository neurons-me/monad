<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1778090977/monad.ai.profile-removebg-preview_np26yp.png"
  />
  <img
    src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1762832023/me.profile-removebg-preview_1_bskwyz.png"
    alt="monad.ai"
    width="203"
  />
</picture>

# monad.ai `2.2.0`

**Active execution agents inside semantic namespaces.**

A monad is a daemon that runs a `.me` kernel, exposes it over HTTP, resolves namespace paths, and registers itself on a mesh surface so other monads and users can find it.

```bash
npm install -g monad.ai
monads                         # start the daemon on port 8161
monads proxy                   # start browser gateway on port 8160 (routes name.monad)
```

---

## What a monad does

```
.me kernel      → semantic tree, memory log, identity proof
HTTP surface    → GET /path/name, POST / (write), /__bootstrap (health)
cleaker         → anchors the kernel to a namespace (suign.cleaker.me)
mesh            → announces self, accepts remote monad registrations
```

Every HTTP request carries a `Host` header. The monad resolves it into a namespace and routes the read or write into the correct kernel branch:

```
GET /profile/name
Host: suign.cleaker.me
→ me://suign.cleaker.me:read/profile/name
```

---

## URL model

`monad.ai` separates **meaning** (namespace + path) from **execution** (which daemon answers):

```
me://<namespace>/<path>         canonical semantic address
http://127.0.0.1:<port>/path    transport address for browser / curl / fetch
```

The HTTP surface is what you call. The `me://` address is what the namespace, mesh, logs, and routing layer use internally.

```bash
curl http://127.0.0.1:8161/profile/name -H "Host: suign.cleaker.me"
# → reads profile.name from the suign.cleaker.me kernel

curl -X POST http://127.0.0.1:8161/ \
  -H "Host: suign.cleaker.me" \
  -H "Content-Type: application/json" \
  -d '{"expression":"profile.name","value":"Sui"}'
# → writes into the namespace memory log
```

---

## monad[name] — scope-chain routing

Targets can name a specific monad using bracket syntax:

```
me://suign.cleaker.me:read/monad[frank]/projects/x
```

The bridge extracts `monadId = "frank"` and resolves via fallback chain:

```
1. frank @ suign.cleaker.me   (compound — exact match)
2. frank @ cleaker.me         (rootspace — fallback)
3. 404
```

Same name resolves differently depending on namespace context. Mirrors JS prototype chain / CSS cascade / DNS resolution.

The bridge strips the `monad[name]` prefix before proxying — frank's endpoint receives the request at `/projects/x`, not at `/monad[frank]/projects/x`.

---

## Mesh — announce and discovery

### Outgoing: monad announces itself

Set `MONAD_SURFACE_URL` to any surface and the monad announces itself on startup and every 30 seconds:

```bash
MONAD_SURFACE_URL=https://cleaker.me monads        # announce to public mesh
MONAD_SURFACE_URL=http://sui-macbook.local:8161 monads  # announce to LAN mesh
# (unset) = local-only, invisible to any remote surface
```

The announce interval is configurable:

```bash
MONAD_ANNOUNCE_INTERVAL_MS=60000 monads  # announce every 60s instead of 30s
```

### Incoming: `POST /.mesh/announce`

Any monad can register on any surface:

```json
POST /.mesh/announce
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

Response:

```json
{ "ok": true, "registered": true, "namespace": "suign.cleaker.me", "monad_id": "monad:abc123" }
```

Surfaces throttle repeated announces: minimum 10 seconds between accepted registrations from the same `monad_id`. Entries go stale after 5 minutes without a heartbeat.

### Query: `GET /.mesh/monads`

Returns all registered monads on this surface. Used by the `surface[]` mesh resolver.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8161` | HTTP port |
| `SEED` | — | Kernel seed (required for identity) |
| `MONAD_SURFACE_URL` | — | Surface to announce self to |
| `MONAD_ANNOUNCE_INTERVAL_MS` | `30000` | Heartbeat interval (min 10s) |
| `MONAD_SELF_IDENTITY` | — | Explicit namespace override |
| `CLEAKER_NAMESPACE_ROOT` | — | Namespace root override |
| `HOSTNAME` / `COMPUTERNAME` | — | Auto-discovered for local surface |

---

## Identity & claims

Before a namespace can receive writes, it must be claimed. A claim anchors a cryptographic identity — derived from `(who, secret)` via `this.me` — to the namespace:

```bash
POST /
Host: suign.cleaker.me
{ "operation": "claim", "secret": "...", "proof": { ... } }
```

Opening a claimed namespace returns the memory log for that identity. The caller replays it locally into their own `.me` kernel:

```bash
POST /
Host: suign.cleaker.me
{ "operation": "open", "secret": "...", "identityHash": "..." }
→ returns memories[] replayable by .me
```

The daemon verifies the proof but never holds the seed. The seed never leaves the client.

---

## The kernel is the storage

Every write becomes a memory event in an append-only, hash-chained log:

```
memoryHash → prevMemoryHash → path → operator → value → timestamp → namespace
```

The `/blocks` endpoint projects that log. No separate database. No migrations. On restart, the daemon hydrates from the DiskStore — nothing is lost.

---

## Surface hierarchy

```
Priority order for surface resolution:
1. local processes first
2. LAN / .local devices  (os.hostname() → suis-macbook-air.local)
3. trusted mirrors
4. public surface (cleaker.me)
```

Every monad auto-discovers its own local surface via `os.hostname()`. This is the same mechanism `cleaker` uses for fallback — no configuration needed, devices find each other naturally on the LAN.

---

## Deployment topologies

### Local only (no mesh, invisible externally)
```bash
# MONAD_SURFACE_URL unset
SEED="my-seed" monads
# Reachable only from same machine at http://localhost:8161
```

### Personal LAN mesh
```bash
MONAD_SURFACE_URL=http://sui-macbook.local:8161 SEED="my-seed" monads
# All LAN devices announce to the Mac; Mac serves as private mesh registry
```

### Community namespace (public mesh)
```bash
MONAD_SURFACE_URL=https://cleaker.me SEED="my-seed" monads
# Monad appears in public directory
# Namespace owner controls traffic rules, billing, access policies
```

---

## Running locally

```bash
cd npm
npm install
npm run build
SEED="your-seed" node dist/src/index.js
```

```bash
# read
curl http://localhost:8161/profile/name

# write
curl -X POST http://localhost:8161/ \
  -H "Host: suign.cleaker.me" \
  -H "Content-Type: application/json" \
  -d '{"expression":"profile.name","value":"Sui"}'

# health
curl http://localhost:8161/__bootstrap
```

---

## Install

```bash
# Global daemon
npm install -g monad.ai

# Project dependency
npm install monad.ai
```

---

## KDF deterministic identity

When `SEED` is set, monad derives its Ed25519 keypair deterministically via HKDF:

```
HKDF-SHA256(compound_seed, salt='', info='monad.ai/ed25519/v1', length=32) → Ed25519 seed
```

Same `(who, secret)` → same monad identity everywhere, every time. No key files to sync across machines.

```bash
SEED="your-seed" monads   # deterministic identity
monads                    # random keypair (backwards compatible)
```

---

## Browser gateway

```bash
monads proxy               # start on port 8160 (default)
monads proxy --port 9000   # custom port
```

Configure browser to use PAC file: `http://127.0.0.1:8160/proxy.pac`

Then open `frank.monad`, `local.monad`, or `localhost:8161` in the browser — all route to the correct running monad.

---

## The stack

```
this.me    → sovereign kernel. derives identity from (who, secret) seed. works offline.
cleaker    → resolver. projects .me into a namespace surface. handles fallback chain.
monad.ai   → daemon. runs the kernel over HTTP. registers on the mesh.
netget     → gateway. routes physical requests to monad endpoints.
```

> The namespace is not storage. The namespace is chemistry.
> It is the surface where identities react and compounds form.
