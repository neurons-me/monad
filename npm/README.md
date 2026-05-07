<picture>
  <source
    media="(prefers-color-scheme: dark)"
   srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1778090977/monad.ai.profile-removebg-preview_np26yp.png"
  />
  <img
    src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1762832023/me.profile-removebg-preview_1_bskwyz.png"
    alt=".me Logo"
    width="203"
  />
</picture>

# monad.ai - npm 

`monad.ai` is a system for running **monads**: active execution agents that live inside a *namespace.*

*namespace = semantic tree = meaning*

# Getting Started

**Install globally**:

```bash
npm install -g monad.ai
```

**Then run:**

```bash
monads
```

**Or run without installing globally:**

```bash
npx monad.ai
```

**For local project usage:**

```bash
npm install monad.ai
```

# URL Model

`monad.ai` separates **meaning** from **execution**.

A semantic URL points to a **namespace** and a path:

***me://<namespace>/<path>***

```bash
GET /__surface
host=127.0.0.1
ns=host-name.local
op=read
nrp=me://host-name.local:read/__surface
```

#### **Where do I use this?**

Use the **HTTP surface in the browser**, terminal, or app:

```bash
curl http://127.0.0.1:<port>/profile
```

The running **monad** receives that HTTP request and maps it into a canonical semantic address:

```txt
me://<namespace>:read/profile
```

So you usually do **not** run this directly:

```bash
curl me://host-name.local/profile
```

unless you have a `me://` protocol handler or gateway installed.

Think of it like this:

```txt
Browser / curl / fetch:
http://127.0.0.1:<port>/profile

Semantic / NRP / logs / mesh:
me://host-name.local:read/profile
```

`http://127.0.0.1:<port>` reaches the running monad surface.

`me://...` is the canonical semantic address used by the namespace, mesh, logs, replay, and routing layer.

**Example:**

```
me://host-name.local/profile
```

The port is not part of the semantic identity. Ports are only used by the *local HTTP transport layer* to reach a running **monad:**

```
me://host-name.local/profile
```

## **root-name:** 

```
host-name.local
```

## **/path :**      

```
/profile
```

It does **not** mean:

```
localhost:8161
```

The mesh chooses the best running monad that can serve that namespace.

## Selectors [ ]

By default, `monad.ai` chooses the best monad automatically.

```md
me://host-name.local/profile
```

You can optionally constrain execution with a selector:

```
me://host-name.local[lisa]/profile
```

This still points to the same semantic node:

```
host-name.local/profile
```

but **asks the** **mesh** to execute it through the `lisa` monad.

Multiple eligible monads can be provided:

```
me://host-name.local[lisa,worker-a]/profile
```

An empty selector means “***use the mesh resolver***”:

```
me://username.cleaker.me[]/profile
```

**Execution Overrides** (*advanced/debug*):

```txt
me://host-name.local[lisa]/profile # force specific monad
me://host-name.local[lisa,worker-a]/profile
```

**Internal Registry**:

```
me://host-name.local/.monad[]/ # monads registry
me://host-name.local/.monad[lisa]/status
```

***monad.ai*** chooses the **best route** internally. A selector is for *diagnostics, replay, or advanced routing*...

```txt
me://username.cleaker.me[]/profile
```

That still targets the same semantic node: `username.cleaker.me/profile`.

### Adaptive Mesh Routing

```
rootspace = semantic place
namespace = address of that place
path = branch inside that place
monad = active surface serving it
port = local transport detail
me:// = canonical semantic/NRP form
http:// = how browser/curl reaches the running surface
selector = execution constraint, not meaning
```

The current **NRP** mesh is adaptive:
- monads announce which namespaces they can serve
- selectors constrain eligible execution routes
- the scoring engine chooses the best claimant
- outcomes feed back into adaptive weights
- namespace-local weights gradually override the global prior as evidence accumulates

Useful inspection endpoints:

```bash
curl http://localhost:8161/.mesh/monads
curl "http://localhost:8161/.mesh/resolve?namespace=suis-macbook-air.local"
curl http://localhost:8161/.mesh/weights
curl "http://localhost:8161/.mesh/weights?namespace=suis-macbook-air.local"
```

Live learning monitor:

```bash
tsx scripts/watch-weights.ts
tsx scripts/watch-weights.ts --namespace suis-macbook-air.local
```

# CLI Usage
**Run in your terminal:**

```bash
monads
```

Opens the local ***monad control panel.*** It lists running **monads** by name and exposes:

```bash
Start a New Monad
View All Monads
Stop a Monad
View Monad Logs
View Monad Status
```

**Direct commands:**

```bash
monads start api
monads start
monads stop api
monads status
monads logs api
monads logs api --tail
```

Each **monad** gets its own process name, port, state directory, claim directory,
runtime tags, and logs under `~/.monad/<name>/`.

Each **monad** also gets a local `cleaker(monad)` **keypair**. 
- The ***private key*** stays in that *monad's local key file.* 
- The ***public key*** derives `monad.id`, and `__surface` publishes a <u>signed proof</u> so the same **monad can be recognized** even if its port or endpoint changes.
The **namespace/rootspace** is the <u>host or domain</u> context; the port only belongs to the endpoint. That means many **monads** can run on different ports while *serving the same rootspace.*

Normal reads should use semantic paths:

```txt
me://suis-macbook-air.local/profile
me://suis-macbook-air.local/photos/iphone
```

Advanced/debug reads may constrain execution:

```txt
me://suis-macbook-air.local[monadlisa]/profile
me://suis-macbook-air.local[monadlisa,worker-a]/profile
```

**monads** registry and placement data are ordinary internal paths:

```txt
me://suis-macbook-air.local/.monad[]/
me://suis-macbook-air.local/.monad[lisa]/status
```

Default resolution may use latest hash, quorum, stale-state detection,
authority, and budget policy internally, but the caller gets one semantic answer.
If no name is provided, the CLI creates one automatically. In the interactive
control panel, namespace is derived from this machine's host rootspace. 
If no `SEED` is provided, the CLI uses a local deterministic development seed for that **monad** name.
`monads logs <name>` follows the live stdout/stderr stream, so incoming requests appear as they happen. Use `--tail` when you only want the latest snapshot.

## Manual Server
```bash
SEED="mi-seed-local-dev" npm run dev
```

If you prefer to run from dist:

```bash
SEED="mi-seed-local-dev" node dist/server.js
```

# License
**MIT**
https://neurons.me
