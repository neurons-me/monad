# monad.ai, Cleaker, and Public Roots
This page fixes a common confusion in the stack:
- `.me` is the semantic kernel
- `monad.ai` runs monads: active execution agents
- `cleaker` is the binder that projects a `.me` into a namespace
- `cleaker.me` is the canonical public root.

---

## Core Roles
### `.me`
`.me` is the kernel.

**It owns:**
- identity derivation from seed
- keys and secret scopes
- semantic tree and memory log
- snapshots, hydration, replay
- cryptographic proof of identity

Examples:
- `me://self:read/profile`
- `me://self:write/profile.name`
- `me://self:explain/profile.netWorth`

### `monad.ai`
`monad.ai` runs monads: active agents that serve, resolve, and execute inside a namespace.
It owns:

- serving namespace requests over HTTP
- resolving namespaces from the `Host` header
- persisting the kernel state via DiskStore
- handling claim/open lifecycle
- Monad process lifecycle, logs, status, and local execution

A **monad** can run only for you on localhost, or it can be exposed publicly on a domain.
The kernel is the storage. There is no separate database.
A **monad** is not the namespace, not the host, and not the port. It is a *semantic execution route* chosen by the resolver:

```txt
jabellae.cleaker.me/profile                 semantic path / meaning
jabellae.cleaker.me/photos/iphone           semantic path / meaning
jabellae.cleaker.me/.mesh/monads            internal Monad registry
jabellae.cleaker.me[monadlisa]/profile      technical execution override
monadlisa@127.0.0.1:8161                    Monad instance + endpoint
```

The normal user-facing address has no monad selector:

```txt
me://jabellae.cleaker.me/profile
```

A monad selector is only a technical override. These still target the same semantic node:

```txt
me://jabellae.cleaker.me[monadlisa]/profile
me://jabellae.cleaker.me[monadluis]/profile
```

### `cleaker`
`cleaker` is the binder.
It takes a `.me` instance and projects it into a namespace context. It handles the full bind lifecycle automatically:
1. Ask `.me` to prove identity
2. Attempt to open the namespace
3. If the namespace does not exist yet, claim it
4. Reopen and hydrate the kernel with the returned memories

```ts
const node = cleaker(me, {
  secret,
  namespace: 'username.cleaker.me',
  space: 'cleaker.me',
})

await node.ready
```

`cleaker` does not store anything. It does not own the identity. It connects `.me` to a namespace and hands control back.

Cleaker does not decide where a Monad runs. That belongs to NetGet.

### `https://cleaker.me`
`cleaker.me` is not a different protocol.
It is a **public domain** with Monads that act as a canonical public root — a common agreement where identities can be anchored publicly.

###### That means:
- infrastructure-wise, it is a public namespace served by Monads
- semantically, it is a well-known root for public namespaces like `jabellae.cleaker.me`
Any domain running compatible Monads can play this role. `cleaker.me` is the default, not the only option.

---

# Deployment Roles
### Local-only Monad
A local-only Monad runs only for you — on your laptop, your home server, your LAN. It does not need to be publicly accessible.

```
http://suis-macbook-air.local:8161/
```

You get the full kernel, the full memory log, the full identity — just not exposed to the internet.

### Application domain
An application domain — like `otherNamespace.com`  — can run its own  `monad.ai` and use it as the namespace root for its users.
Users anchor their identity there:

```
username.othernamespace.com
```

The app does not need to use `cleaker.me`. It is its own notary.

### Public root
A public root is a domain that exposes namespace behavior publicly and lets anyone anchor an identity under it.
Examples:
- `cleaker.me` — the canonical public root
- any other domain running a public `monad.ai`

---

## Canonical Address vs Web Projection
`me://` is the canonical semantic address.
`https://` is one possible public projection of that address.

```
me://username.cleaker.me:read/profile
https://username.cleaker.me/profile
```

```
me://username.othernamespace.com:read/profile
https://username.othernamespace.com/profile
```

The semantic target is primary. The web URL is a projection chosen by the host.

---

## Key Spaces and Privacy
Topology does not imply publicity.
A space can be replicated to multiple Monads — laptop, iPhone, home server, VM — and still remain completely private. The distinction is:
- **topology** decides where the ciphertext exists
- **audience** decides who can open it
So a key space may live on many Monads and still remain private if its audience is cryptographically closed.

```
T = {monadlisa, worker-a, phone-agent}  ← Monads where it lives
A = {jabellae}                         ← who can read it
```

---

## NetGet
NetGet is the physical placement and endpoint layer. It can place a Monad on a laptop, iPhone, Raspberry Pi, VM, relay, or localhost and resolve that placement into a current endpoint.

```txt
me.monad[monad_id].endpoint("netget://iphone/monadlisa")
NetGet resolves that to http://10.0.0.12:8161
```

The user asks for meaning. The resolver chooses a Monad route. NetGet handles the body that route runs in.

---

## One-line Model
- `.me` holds the identity and the tree
- `cleaker` binds `.me` to a namespace
- `monad.ai` runs Monads that serve and execute inside that namespace
- `NetGet` places those Monads and resolves endpoints
- `cleaker.me` is one public root among many possible ones

---

## Rule
- Every app can use `.me`
- Not every app needs `cleaker`
- Every public root can run `monad.ai`
- `cleaker.me` is the canonical default, not the only option
