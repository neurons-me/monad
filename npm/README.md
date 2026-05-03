# monad.ai 

`monad.ai` runs monads: active execution agents inside a namespace.

```txt
namespace                 = semantic tree / meaning
Monad                     = invisible execution route inside that namespace
endpoint                  = transport only
```

The port never changes the namespace. The host physical location is not the identity.

```txt
suis-macbook-air.local/profile                 semantic path
suis-macbook-air.local/photos/iphone           semantic path
suis-macbook-air.local/.mesh/monads            internal Monad registry
suis-macbook-air.local[monadlisa]/profile      technical execution override
monadlisa@127.0.0.1:8161                       Monad + endpoint
```

The canonical user-facing form has no selector:

```txt
me://jabellae.cleaker.me/profile
```

The resolver chooses the best Monad route internally. A Monad selector is only
for diagnostics, replay, or advanced routing:

```txt
me://jabellae.cleaker.me[monadlisa]/profile
```

That still targets the same semantic node: `jabellae.cleaker.me/profile`.

Install the CLI

Run in your terminal:

```bash
monads
```

Opens the local monad control panel. It lists running monads by name and exposes:

```txt
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

Advanced namespace override:

```bash
monads start api --namespace sui-laptop.local
```

Each Monad gets its own process name, port, state directory, claim directory,
runtime tags, and logs under `~/.monad/monads/<name>/`.

Each Monad also gets a local `cleaker(monad)` keypair. The private key stays in
that Monad's local key file. The public key derives `monad.id`, and `__surface`
publishes a signed proof so the same Monad can be recognized even if its port or
endpoint changes.

The monad name is not the namespace.

The namespace/rootspace is the host or domain context; the port only
belongs to the endpoint. That means many monads can run on different ports while
serving the same rootspace.

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

Monad registry and placement data are ordinary internal paths:

```txt
me://suis-macbook-air.local/.mesh/monads
me://suis-macbook-air.local/.mesh/monads/monadlisa/status
```

Default resolution may use latest hash, quorum, stale-state detection,
authority, and budget policy internally, but the caller gets one semantic answer.

If no name is provided, the CLI creates one automatically. In the interactive
control panel, namespace is derived from this machine's host rootspace. Use
`--namespace` or `--rootspace` only when you intentionally need an advanced
override. If no `ME_SEED` is provided, the CLI uses a local deterministic
development seed for that monad name.

`monads logs <name>` follows the live stdout/stderr stream, so incoming requests
appear as they happen. Use `--tail` when you only want the latest snapshot.

## Manual Server

```bash
ME_SEED="mi-seed-local-dev" npm run dev
```

If you prefer to run from dist:

bash

```bash
ME_SEED="mi-seed-local-dev" node dist/server.js
```

# License
MIT
https://neurons.me
