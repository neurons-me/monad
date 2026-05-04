<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1760759569/me_pio6qj.png" />
  <img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1762832023/me.profile-removebg-preview_1_bskwyz.png" alt=".me Logo" width="203" />
</picture>

# monad
###### Serve `me://Everything.is.just.a.hash.of.a.knowledge.unit`
Run **monads**: agents that serve, resolve, and execute `.me` expressions.

A **namespace** is the *semantic tree*. 

------

### Git Clone Repository

```bash
git clone https://github.com/neurons-me/monad.ai.git
```

Select your language:
| Language    | Source                        | Status           | Documentation                                                |
| ----------- | ----------------------------- | ---------------- | ------------------------------------------------------------ |
| **Node.js** | `cd monad/npm && npm install` | **Stable 2.1.1** | [node.js Docs ⟡ ](https://neurons-me.github.io/.me/npm/typedocs/) |
| **Python**  | `cd monad/pip/`               | Not Available    |                                                              |
| **Rust**    | `cd monad/crate/`             | Not Available    |                                                              |


**Then run providing your local seed:**

```bash
SEED="Tetragramaton" npm run dev
```

If you want to run the compiled build:

```bash
SEED="Tetragramaton" node dist/server.js
```

Run this on any machine, and that machine can host one or many **monads** tuned into the same **namespace.**

------

## What it looks like:

You install it. You run it. Now you have a local Monad that speaks a simple language:

```
"give me suiGn's profile name"
"write that suiGn's email is suign@example.com"
"who is suiGn and what do they have"
```

Any app, any device, any language can talk to it.

------

## How it works:
It's a service you run locally or on any machine you control.
It has one job: **answer semantic questions about a namespace**.

A **namespace** is a named semantic tree — like `jabellae.cleaker.me` or `suis-macbook-air.local`.

A **Monad** is not the namespace, not the host, and not the port. It is the runtime agent the resolver may use internally to answer for the namespace:

```txt
jabellae.cleaker.me/profile                 semantic path / meaning
jabellae.cleaker.me/photos/iphone           semantic path / meaning
jabellae.cleaker.me/.mesh/monads            internal Monad registry
jabellae.cleaker.me[monadlisa]/profile      technical execution override
monadlisa@127.0.0.1:8161                    Monad instance + endpoint
```

Monads are invisible by default. A selector is only an advanced/debug override:

```txt
me://jabellae.cleaker.me/profile
me://jabellae.cleaker.me[monadlisa]/profile
me://jabellae.cleaker.me[monadluis]/profile
```

All target `jabellae.cleaker.me/profile`. The selected Monad only changes execution, not meaning.

**When an app asks:**

```
GET /profile/name
Host: suiGn.cleaker.me
```

It gets back: `"Sui Gn"`

*That's it.*

------

## The pieces:
There are three things working together:

**[.me](https://github.com/neurons-me/.me)** — the kernel. Knows how to store, encrypt, and derive your data from a single seed.

**monad.ai** — the Monad runtime. Takes that engine and gives it active agents that can serve, resolve, execute, and coordinate.
**[cleaker](https://github.com/neurons-me/cleaker)** — the connector. Takes your identity and plugs it into a namespace so apps can find you.
**NetGet** — the placement and endpoint layer. It knows where a Monad physically runs: laptop, iPhone, Raspberry Pi, VM, relay, or localhost.

------

## Where to go from here:
- **Want to run it?** → [npm/README.md](https://claude.ai/chat/npm/README.md)
- **Want to understand the protocol?** → [Namespace Resolution Protocol](https://claude.ai/docs/en/Namespace Resolution Protocol.md)
- **Want to build an app on top of this?** → [this.me on npm](https://npmjs.com/package/this.me)
- **Want to understand the big picture?** → [neurons.me](https://neurons.me/)

------

**MIT —** [neurons.me](https://neurons.me/)



<img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1760629064/neurons.me_b50f6a.png" alt="neurons.me Logo" width="89"/>
