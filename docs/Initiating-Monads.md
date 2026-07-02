---
layout: readme
title: Initiating Monads
---

# Initiating Monads

A monad is an Express HTTP runtime that holds a single `ME` kernel instance. It starts from one thing: a **SEED**.

```bash
SEED=<64-hex-string> node dist/server.js
```

The SEED is the namespace authority — the root from which the kernel derives every identity, path, and secret in that surface. Without it, the monad does not start.

## What happens at startup

1. `getKernel()` calls `new ME(process.env.SEED)` — once, as a singleton.
2. The kernel hydrates from `me-state/snapshot.json` if one exists (prior state).
3. The Express app mounts its routers: `/.monads/*`, `/me/*`, `/claims/*`, `/apps/*`, `/resolve`.
4. The monad registers itself with netget (see below).
5. The heartbeat loop starts — every `MONAD_NETGET_HEARTBEAT_MS` (default 3000ms), the monad re-reports its presence.

## Self-registration with netget

Netget runs at a fixed address (`local.netget` / port 80 via nginx). Every monad can run on an arbitrary port — the port is chosen at startup and is unknown to netget until the monad announces it.

This is why **monad registers with netget, not the other way around**:

```
monad Express (any port)
  └─ POST /apps/report → local.netget:80
       { name, port, host, metadata, health }
```

Netget stores the entry in memory with a TTL of `4 × heartbeatMs`. If the heartbeat stops — monad crashed, was killed, or the process exited — the entry expires and netget considers that surface gone.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `SEED` / `ME_SEED` | ✓ | Namespace authority key |
| `ME_NAMESPACE` | — | Canonical rootspace name (e.g. `suis-macbook-air.local`) |
| `MONAD_NAME` | — | Human name of this surface instance |
| `MONAD_PRIVATE_KEY` | — | Ed25519 surface identity key — generate and persist one per instance |
| `ME_STATE_DIR` | — | Where `snapshot.json` lives (default: `me-state/`) |

## Multiple monads, one namespace

Several monad processes can share the same `ME_NAMESPACE` (e.g. `monad:cleaker`, `monad:netget`). Each reports separately to netget under a different `name`. Netget's mesh scoring picks the healthiest one when routing a request — this is **subtractive synthesis**: the namespace stays stable while individual monads come and go.
