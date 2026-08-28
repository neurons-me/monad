# The Knowledge Graph — Semantic Memory as a Queryable Ledger

**neurons.me / suiGn**
**Status:** Describes the current `monad.ai` implementation (semantic memory log, `appendSemanticMemory`, and the host-telemetry bridge). Not a wire protocol — see [NRP v0.3.0](./NRP-v0.3.0.md) for how a `me://` target actually gets resolved across the mesh.
**License:** CC0 1.0 Universal — Public Domain

---

## 0. The one-sentence version

Every fact a monad writes into its kernel through `appendSemanticMemory` becomes a node in an append-only, hash-chained, path-addressable graph — resolvable through the exact same `me://` machinery as everything else in `.me`, with no separate registration step. There is no distinct "knowledge graph database." The knowledge graph *is* the kernel's semantic memory log, read back.

## 1. Two kinds of kernel writes — only one is a graph node

`monad.ai`'s HTTP layer has two ways to put a value into the kernel, and they are not interchangeable:

| | `kernelSet` | `appendSemanticMemory` |
|---|---|---|
| Where it lives | Raw `.me` proxy chain (`kernel.daemon.claims.foo(value)`) | The replayable, hash-chained memory log |
| Visible to `listSemanticMemoriesByNamespace` / `me://` reads | No | Yes |
| Used for | Internal daemon bookkeeping (`daemon.claims.*`, `daemon.users.*`) | Anything meant to be queried later |

A fact written with `kernelSet` exists, but it is invisible to the knowledge graph — it never appears in a namespace's memory log, never gets a hash, never shows up in a `/blockchain` listing. A fact written with `appendSemanticMemory` does all three. If you want something to be *knowledge* — resolvable, queryable, ordered, hash-chained — it has to go through `appendSemanticMemory`, not `kernelSet`.

## 2. What "queryable" actually means here

Once a value is written via `appendSemanticMemory({ namespace, path, data })`, it is reachable two ways, both already generic — neither requires registering the new path anywhere:

**By exact path**, through the same `me://` resolution every other semantic value uses:

```
GET /apps/<name>/surface/host/cpu   (HTTP, path segments = dots)
me://<namespace>:read/surface.host.cpu   (NRP form)
```

**By listing**, through the namespace's own memory log (what a "Blockchain" tab in a UI renders):

```
GET /apps/<name>/blockchain?prefix=surface.host
```

Both paths resolve through `namespaceToKernelPrefix()` first — write and read under the namespace's *canonical* form (its actual root namespace, e.g. `suis-macbook-air.local`), not a gateway-routing alias (`local.host`, `local.netget`). Those aliases get translated to the canonical namespace by the HTTP layer before either read or write ever reaches the kernel; they are addressing conveniences, not namespaces themselves, and writing under the alias directly would silently land in the wrong place (or nowhere resolvable at all).

## 3. Existing precedent: `surface.usage.*`

Before host telemetry, exactly one thing already bridged live, in-memory metrics into the graph this way: `resources/usageLedger.ts`'s `ResourceUsageLedger`. It listens for HTTP request events and periodically writes two things under the root namespace:

- `surface.usage.requests` — one entry per HTTP request (method, url, status, duration, identityHash)
- `surface.usage.window` — a 10-second rolling aggregate (request rate, CPU ratio)

Every entry carries an Ed25519 signature (`sig: { alg, value, pubKey }`), deterministically derived from the monad's own `SEED` via HKDF — because this feed exists to support "resource crypto": NetGet and downstream accounting consumers need to trust these numbers enough to bill against them. Signing is what makes that trust possible without a central authority re-verifying the daemon's honesty.

## 4. Host telemetry: the second bridge

`resources/hostTelemetryLedger.ts` follows the identical shape — a `start()`/`stop()` timer, sampling live system state and writing it into the same graph — but for a different kind of fact: not "what happened," but "what does this machine currently look like."

Every 30 seconds (configurable via `MONAD_HOST_TELEMETRY_INTERVAL_MS`), it samples and writes three paths under the root namespace:

```
surface.host.cpu      { cores, usageRatio, timestamp }
surface.host.memory   { totalGb, usageRatio, source, usedGb, reclaimableGb, breakdown, timestamp }
surface.host.storage  { totalGb, usageRatio, timestamp }
```

### 4.1 Why memory pressure needed its own measurement

The naive Node.js approach — `(os.totalmem() - os.freemem()) / os.totalmem()` — reads as 90%+ "used" on almost any macOS machine at rest, because macOS deliberately fills "free" RAM with reclaimable disk cache rather than reporting it as free. That number is not wrong, exactly — it is answering a different question ("how much RAM is not instantly zero") than the one that actually matters ("is this machine under memory pressure").

`surface.host.memory.source` reports which measurement was used:

- **`vm_stat`** (macOS) — parses `vm_stat`'s page categories directly: `wired + active + compressed` counts as real, pinned usage; `inactive + speculative + free` counts as instantly reclaimable. This is the same split macOS's own Activity Monitor "Memory Pressure" gauge is built from. `breakdown` carries all six categories in GB.
- **`proc_meminfo`** (Linux) — reads `/proc/meminfo`'s `MemAvailable` field directly (kernel-computed, accounts for reclaimable page cache/slab since Linux 3.14 — no need to hand-roll the equivalent split).
- **`naive`** — the plain total-minus-free fallback, used only when the platform-specific measurement isn't available (any other OS, or if `vm_stat`/`/proc/meminfo` fails to parse).

### 4.2 Why this bridge is unsigned

`surface.usage.*`'s signature exists because that feed backs billing. `surface.host.*` is self-reported observability — "here is what this machine says about itself," the same trust tier as `claimSemantics.ts`'s plain seed writes (also unsigned). If a future use case needs to *bill* against reported hardware capacity, that would warrant a `measured`/`verified` tier distinct from what a host merely reports about itself — a real, separate hardware attestation problem, not solved by adding a signature to a self-report.

## 5. Reading it back

Any client — a browser, a CLI, another monad — reads these the same way it reads anything else in the graph, no special-case client code:

```bash
curl http://<gateway>/apps/<name>/surface/host/cpu
```

```json
{
  "ok": true,
  "value": { "cores": 8, "usageRatio": 0.53, "timestamp": 1787915193156 },
  "disclosure": "public"
}
```

`this.gui`'s `HostSurface` component (`packages/GUI/Typescript/src/gui/All.This/Host/HostSurface.tsx`) is one such client — it polls the live `/__bootstrap` surface entry (which already carries the same computed ratios merged in) for its gauges, rather than reading back through the graph on every render. The graph write exists so the *history* survives past that one HTTP response — so a later query, another surface, or a future aggregation can see what this host reported an hour or a week ago, not just what it reports right now.

## 6. What this is not

- Not a new database. There is exactly one storage mechanism: the kernel's own hash-chained memory log, the same one `users.*` and `daemon.claims.*` already live in.
- Not a wire protocol change. Reading `surface.host.*` uses the same `me://` resolution and HTTP path-resolver every other semantic path already uses — see [NRP v0.3.0](./NRP-v0.3.0.md) for that layer.
- Not verified or attested capacity. See §4.2 — this is self-report, not certification.

## See also

- [NRP v0.3.0](./NRP-v0.3.0.md) — how a `me://` target is resolved across the mesh; this document only covers what happens once a value is already in one kernel's own memory log.
- [Mesh/status.md](./Mesh/status.md) — implementation status of the broader mesh, separate from this bridge.
- `resources/usageLedger.ts` — the signed, billing-facing sibling of this bridge.
