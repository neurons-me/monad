# monad.ai

###### Subtractive Synthesis

- Resolves namespace paths from the `Host` header of incoming HTTP requests
- Accepts writes as semantic memory events, appended to a hash-chained log
- Serves reads as path resolutions over the kernel tree
- Handles claim/open lifecycle for anchoring identities to namespaces
  The storage is the kernel. There is no database, no parallel ledger, no second truth.

```
GET /profile/name
Host: jabellae.cleaker.me
→ resolves profile.name within the jabellae.cleaker.me namespace

POST /
Host: jabellae.cleaker.me
{ "expression": "profile.name", "value": "José" }
→ writes profile.name into the namespace memory log
```

------

## How namespace resolution works
The `Host` header of each request determines the namespace. The **monad.ai** does not need to be told which namespace it "is" — every request carries its own namespace context.

```
Host: cleaker.me → namespace: cleaker.me
Host: jabellae.cleaker.me → namespace: jabellae.cleaker.me
Host: mexicoencuesta.com → namespace: mexicoencuesta.com
```

This means a **monad.ai** can serve multiple namespaces, and any namespace is accessible as long as the `Host` header matches.

**Netget** routes the real domain to the **monad** port:

```
https://cleaker.me  →  reverse proxy  →  localhost:8161
```

In local development, the daemon is accessible directly via hostname:

```
http://suis-macbook-air.local:8161/
```

------

## The kernel is the storage
`monad.ai` runs a [`.me`](https://github.com/neurons-me/.me) kernel backed by a `DiskStore`. Every write becomes a memory event in an append-only, hash-chained log:

```
memoryHash → prevMemoryHash → path → operator → value → timestamp → namespace
```

The `/blocks` endpoint is a projection of that memory log — not a separate ledger.
When the daemon restarts, it hydrates from the DiskStore. No data is lost. No migrations needed.

------

## Identity and claims

Before a namespace can receive writes, it must be claimed. A claim anchors a cryptographic identity — derived from a seed via [`.me`](https://github.com/neurons-me/.me) — to a namespace:

```
POST /
Host: jabellae.cleaker.me
{ "operation": "claim", "secret": "...", "proof": { ... } }
```

Opening a claimed namespace returns the memory log for that identity, which the caller can replay locally into their own `.me` kernel:

```
POST /
Host: jabellae.cleaker.me
{ "operation": "open", "secret": "...", "identityHash": "..." }
→ returns memories replayable by .me
```

The claim is anchored to an `identityHash` produced by `.me`. The daemon verifies the proof but does not hold the seed. The seed never leaves the client.

------

## The stack

```
.me        →  the semantic kernel. derives identity, holds the tree, produces proofs.
monad.ai   →  the daemon. runs the kernel, exposes it over HTTP, resolves namespaces.
cleaker    →  the binder. takes a .me instance and projects it into a namespace context.
```

`monad.ai` is one possible surface. You can run your own daemon on any hostname or domain. The namespace is not tied to this implementation.

------

## Running locally
```bash
cd npm
npm install
npm run build
SEED="your-seed" node dist/server.js
```

The daemon listens on port `8161` by default. Set `PORT` to change it.

```bash
# read from the root namespace
curl http://localhost:8161/profile/name

# write to a namespace
curl -X POST http://localhost:8161/ \
  -H "Host: jabellae.localhost" \
  -H "Content-Type: application/json" \
  -d '{"expression":"profile.name","value":"José"}'

# read it back
curl -H "Host: jabellae.localhost" http://localhost:8161/profile/name
```

------

## Protocol
`monad.ai` implements the HTTP binding described in [Namespace Resolution Protocol v0.1.2](https://claude.ai/docs/en/Namespace Resolution Protocol.md).

The canonical resource grammar is:

```
me://namespace[selector]/path
```

The current HTTP binding maps this to:

```
GET  /<path>   Host: <namespace>   →  read
POST /         Host: <namespace>   →  write | claim | open
```

------

## What it is not
- Not a central registry. There is no global list of namespaces.
- Not an identity provider. Identity is derived by `.me` from the user's seed.
- Not a replacement for a database. It is a semantic surface for live state and identity.
- Not the only possible daemon. Anyone can run a compatible surface on any domain.

------

## License

**MIT** — [neurons.me](https://neurons.me/)
