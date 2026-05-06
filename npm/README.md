# monad.ai 
###### npm README.md
`monad.ai` is a system for running **monads**: active execution agents that live inside a *namespace.*

```bash
git clone https://github.com/neurons-me/monad.git
cd monad/npm/
npm install
npm run test
```

Everything is addressed semantically. The port is just an implementation detail for routing — it never changes the underlying **meaning/namespace**.
*namespace = semantic tree = meaning*
**Semantic Paths** (user-facing, canonical):

```txt
me://suis-macbook-air.local/profile
me://suis-macbook-air.local/photos/iphone
me://jabellae.cleaker.me/profile # clean public form
```

**Execution Overrides** (advanced/debug):

```txt
me://suis-macbook-air.local[lisa]/profile # force specific monad
me://suis-macbook-air.local[monadlisa,worker-a]/profile
```

**Internal Registry**:

```
me://suis-macbook-air.local/.monad[]/ # monads registry
me://suis-macbook-air.local/.monad[lisa]/status
```

*monad.ai* chooses the **best route** internally. A selector is for *diagnostics, replay, or advanced routing*...

```txt
me://jabellae.cleaker.me[]/profile
```

That still targets the same semantic node: `jabellae.cleaker.me/profile`.

### Adaptive Mesh Routing
The current NRP mesh is adaptive:
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

### Install the CLI
**Run in your terminal:**

```bash
monads
```

Opens the local *monad control panel.* It lists running **monads** by name and exposes:

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
