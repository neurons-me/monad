# monad.ai `2.2.0`

> Active execution agents inside semantic namespaces.
**Current status:** monad.ai v2.2.0 — NRP chemistry frozen at `nrp-chemistry-v0.1` (2026-05-07).

Includes full NRP mesh stack:
- Phase 1–8 complete: namespace discovery, selector routing, production scoring, decision introspection, decision logs, continuous reward, low-margin exploration, patch bay
- Mesh announce: `POST /.mesh/announce` incoming + `MONAD_SURFACE_URL` outgoing heartbeat
- Scope-chain routing: `monad[frank]` compound → rootspace → 404 fallback

Start here for implementation details:
- [NRP Implementation Status](./NRP/status.md)
- [NRP Scoring Engine](./NRP/scoring.md)
- [NRP Test Documentation](./NRP/testing.md)
- [Architecture: NRP Chemistry](./architecture/nrp-chemistry.md)
- [Generated API Reference](./api/README.md)

---

## What monad.ai does
Every HTTP request carries a `Host` header. The monad resolves it into a namespace and routes into the correct kernel branch:

```
GET /profile/name
Host: suign.cleaker.me
→ me://suign.cleaker.me:read/profile/name
→ reads profile.name from suign.cleaker.me kernel
```

```
POST /
Host: suign.cleaker.me
{ "expression": "profile.name", "value": "Sui" }
→ writes into namespace memory log (append-only, hash-chained)
```

The storage is the kernel. No database, no parallel ledger, no second truth.

---

## monad[name] — scope-chain routing

```
me://suign.cleaker.me:read/monad[frank]/projects/x
```

Resolves via fallback chain:

```
1. frank @ suign.cleaker.me   (compound — exact match)
2. frank @ cleaker.me         (rootspace — fallback)
3. 404
```

The bridge strips `monad[frank]` before proxying. Frank's endpoint receives `/projects/x`.

---

## Mesh — announce and discovery

### Outgoing announce (MONAD_SURFACE_URL)

```bash
MONAD_SURFACE_URL=https://cleaker.me monads
# POST /.mesh/announce to cleaker.me on startup + every 30s
```

### Incoming announce

```json
POST /.mesh/announce
{
  "monad_id": "monad:abc123",
  "name": "frank",
  "namespace": "suign.cleaker.me",
  "endpoint": "http://raspberry.local:8161"
}
```

Throttled at 10s minimum between accepted registrations from the same `monad_id`. Entries expire after 5 minutes without heartbeat.

---

## How namespace resolution works

The `Host` header determines the namespace. A monad needs no static config — every request carries its own namespace context.

```
Host: cleaker.me          → namespace: cleaker.me
Host: suign.cleaker.me    → namespace: suign.cleaker.me
Host: mexicoencuesta.com  → namespace: mexicoencuesta.com
```

One daemon can serve any number of namespaces. NetGet routes real domains to the monad port.

---

## The kernel is the storage
Every write is a memory event in an append-only, hash-chained log:

```
memoryHash → prevMemoryHash → path → operator → value → timestamp → namespace
```

The `/blocks` endpoint projects that log. On restart, the daemon hydrates from the DiskStore. No migrations needed.

---

## Identity and claims
Before writes are accepted, the namespace must be claimed. A claim anchors the cryptographic identity derived by `this.me` to the namespace:

```bash
POST /  { "operation": "claim", "secret": "...", "proof": { ... } }
POST /  { "operation": "open",  "secret": "...", "identityHash": "..." }
```

The daemon verifies the proof. It never holds the seed. The seed never leaves the client.

---

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `8161` | HTTP port |
| `SEED` | — | Kernel seed |
| `MONAD_SURFACE_URL` | — | Surface to announce self to |
| `MONAD_ANNOUNCE_INTERVAL_MS` | `30000` | Heartbeat interval (min 10s) |
| `MONAD_SELF_IDENTITY` | — | Namespace override |
| `CLEAKER_NAMESPACE_ROOT` | — | Namespace root override |

---

## Running locally
```bash
npm install && npm run build
SEED="your-seed" node dist/src/index.js

curl http://localhost:8161/__bootstrap
curl http://localhost:8161/profile/name
```

---

## The stack
```
this.me    → sovereign kernel. (who, secret) → seed → identity + tree.
cleaker    → resolver. projects .me into a namespace surface.
monad.ai   → daemon. runs the kernel, exposes HTTP, registers on mesh.
```

> The namespace is not storage. The namespace is chemistry.
> It is the surface where identities react and compounds form.
