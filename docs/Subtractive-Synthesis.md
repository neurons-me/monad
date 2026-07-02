---
layout: readme
title: Monad — Subtractive Synthesis
---

# Monad: Subtractive Synthesis

In audio synthesis, **subtractive synthesis** starts with a rich source signal and removes what you don't need — the output is defined by what remains after filtering, not by building up from scratch.

Monad routing works the same way.

## The model

A namespace like `suis-macbook-air.local` is not a single process. It is a **surface** — potentially many monad Express instances running at different ports, each handling a slice of the workload:

```
suis-macbook-air.local
  monad:cleaker   → port 4101  (healthy)
  monad:netget    → port 4102  (healthy)
  monad:cold-store           (sleeping)
```

Netget does not know which monad to route to in advance. Instead, it holds all registered entries for that namespace and **subtracts** the ones that are unfit:

```
all registered monads for namespace
  − expired entries (TTL elapsed, heartbeat stopped)
  − unhealthy entries (health check failing)
  ─────────────────────────────────────────────
  → route to the highest-scored remaining monad
```

The scoring (`meshSelect.ts`) weighs `lastSeenMs`, health state, and capability flags. The winner gets the proxied request.

## Why this matters

- **The namespace is stable** even as individual monads restart, crash, or scale.
- **No central coordinator** decides what's alive — each monad declares itself alive by sending heartbeats. Silence means absence.
- **New monads join** by registering. Old ones leave by going silent. The surface reshapes itself continuously.

This is the opposite of additive: you don't build the namespace by enumerating every piece. You start with everything that has announced itself and cut away what's gone.

## Relation to the Monad bubble

The `Monad` component's `healthy` prop reflects the synthesized output of this process — it is `true` when at least one monad in the mesh remains after filtering, `false` when all have been subtracted away, and `null` when no entries have ever arrived.

The orb does not represent one process. It represents whether the **surface** is alive.
