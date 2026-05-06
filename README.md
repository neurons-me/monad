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

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1769890772/this.me.png" />
  <img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1761149332/this.me-removebg-preview_2_j1eoiy.png" alt=".me Logo" width="144" />
</picture>

# monad
###### Serve `me://Everything.is.just.a.hash.of.a.knowledge.unit`
Run **monads**: agents that serve, resolve, and execute `.me` expressions.
A **namespace** is the *semantic tree*. **Chained of truths.**

Subtractive Synthesiser.

------

### Clone Git Repository

```bash
git clone https://github.com/neurons-me/monad.git
cd monad/
```

##### Select your language:

| Language    | Source                        | Status           | Documentation |
| ----------- | ----------------------------- | ---------------- | ------------- |
| **Node.js** | `cd monad/npm && npm install` | **Stable 2.1.1** | [node.js Docs ⟡](https://neurons-me.github.io/.me/npm/typedocs/) |
| **Python**  | `cd monad/pip/`               | Not Available    |               |
| **Rust**    | `cd monad/crate/`             | Not Available    |               |

**Example in npm:**

```bash
cd npm
npm install
npm run test
```

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

`.me` → `cleaker` → `monad.ai` → `NetGet` → `cleaker.me`

------

## How it works:
It's a service you run locally or on any machine you control.
It has one job: **answer semantic questions about a namespace**.

A **namespace** is a named semantic tree — like `jabellae.cleaker.me` or `suis-macbook-air.local`.

A **monad** is the runtime agent the resolver may use internally to answer for the namespace:

```txt
jabellae.cleaker.me/profile                 semantic path / meaning
jabellae.cleaker.me/photos/iphone           semantic path / meaning
jabellae.cleaker.me/.mesh/monads            internal Monad registry
me://jabellae.cleaker.me[Lisa]/profile			technical execution override
me://jabellae.cleaker.me[Haiku]/profile			technical execution override
monadlisa@127.0.0.1:8161                    Monad instance + endpoint
```

All target `jabellae.cleaker.me/profile`. 
> ***The selected monad only changes execution, not meaning.***
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

**monads** — active agents that can serve, resolve, execute, and coordinate.

**[cleaker](https://github.com/neurons-me/cleaker)** — the connector. Takes your identity and *plugs it into a namespace* so apps can find you.

**netGet** — the placement and endpoint layer. It knows where a Monad physically runs: *laptop, iPhone, Raspberry Pi, VM, relay, or localhost.*

------

## Where to go from here:
- **Want to run it?** → [npm/README.md](https://claude.ai/chat/npm/README.md)
- **Want to understand the protocol?** → [Namespace Resolution Protocol](https://claude.ai/docs/en/Namespace Resolution Protocol.md)
- **Want to build an app on top of this?** → [this.me on npm](https://npmjs.com/package/this.me)
- **Want to understand the big picture?** → [neurons.me](https://neurons.me/)

------

**MIT —** [neurons.me](https://neurons.me/)

<img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1760629064/neurons.me_b50f6a.png" alt="neurons.me Logo" width="89"/>
