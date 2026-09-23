<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1778090977/monad.ai.profile-removebg-preview_np26yp.png"
  />
  <img
    src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1762832023/me.profile-removebg-preview_1_bskwyz.png"
    alt=".me Logo"
    width="103"
  />
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1769890772/this.me.png" />
  <img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1761149332/this.me-removebg-preview_2_j1eoiy.png" alt=".me Logo" width="144" />
</picture>

# monad
> *A federated semantic compute runtime.*

A **monad** is a daemon: it holds a live `.me` kernel, answers for a namespace over HTTP, and registers itself on the mesh so other monads and users can find it — talk to it through [`me.whatever(what)`](https://neurons-me.github.io/me.whatever.what.html) syntax.

`me://Everything.is.just.a.hash.of.a.knowledge.unit`

------

## ⚡ Quick Start your Monads

A monad is a daemon: a process you run that holds a live `.me` kernel, answers for a namespace over HTTP, and registers itself on the mesh so other monads and users can find it.

**Clone**

```bash
git clone https://github.com/neurons-me/monad.git
cd monad/
```

**Choose a runtime**

🔷 **TypeScript** — the only runtime that exists today. Stable, 2.1.1.

```bash
cd Typescript
npm install
npm run test
```

🦀 **Rust** — not available yet. 🐍 **Python** — not available yet.

**Run it.** A monad needs a seed — the 64-hex key its namespace identity and every derived secret trace back to. Same seed, same namespace, every time.

```bash
SEED="Tetragramaton" npm run dev
```

Or the compiled build:

```bash
SEED="Tetragramaton" node dist/server.js
```

**Talk to it.** Two ways in, same tree either way.

Over the wire, from any app, any device, any language:

```
GET /profile/name
Host: username.cleaker.me
```

```
"username" // that's it
```

In-process, writing directly against the kernel it holds:

```ts
me["@"]("jabellae");            // your digital identity
me.profile.name("José Abella"); // declare meaning

me("profile.name"); // "José Abella" — resolve meaning
```

**One tree, many monads.** Run this on any machine, and that machine can host one or many monads, all tuned to the same namespace. Adding another one never changes the namespace — only which monad is currently answering for it, decided by **subtractive synthesis**: no central coordinator picks a monad in advance; the mesh holds every registered monad for the namespace and subtracts the dead ones, routing to whichever survives.

Full walkthrough — env vars, the compiled build, the subtractive-synthesis mechanism in full: <a href="https://neurons-me.github.io/QuickStart.Monads.html" target="_blank" rel="noopener noreferrer">Quick Start your Monads →</a>

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

## What the system is now

### Not:
- a chatbot framework,
- a cloud AI platform,
- or a blockchain protocol.

### It is now:

> a federated semantic compute runtime

### with:
- sovereign identity,
- namespace chemistry,
- contextual routing,
- distributed monads,
- live mesh resolution,
- local-first continuity,
- recursive AI agents.

------

## How it works:

It's a service you run locally or on any machine you control.
It has one job: **answer semantic questions about a namespace**.

A **namespace** is a named semantic tree — like `username.cleaker.me` or `user-macbook-air.local`.

A **monad** is the runtime agent the resolver may use internally to answer for the namespace:

```txt
username.cleaker.me/profile                 semantic path / meaning
username.cleaker.me/photos/iphone           semantic path / meaning
username.cleaker.me/.mesh/monads            internal Monad registry
me://username.cleaker.me[Lisa]/profile			technical execution override
me://username.cleaker.me[Haiku]/profile			technical execution override
lisa@127.0.0.1:8161                    Monad instance + endpoint
```

All target `username.cleaker.me/profile`. 
> ***The selected monad only changes execution, not meaning.***

------

## The pieces:
There are three things working together:

**[.me](https://neurons-me.github.io/.me/)** — the kernel. Knows how to store, encrypt, and derive your data from a single seed.

**[monads](https://neurons-me.github.io/monad/)** — active agents that can serve, resolve, execute, and coordinate.

**[cleaker](https://neurons-me.github.io/Cleaker)** — the connector. Takes your identity and *plugs it into a namespace* so apps can find you.

**[netGet](https://neurons-me.github.io/netget/)** — the placement and endpoint layer. It knows where a Monad physically runs: *laptop, iPhone, Raspberry Pi, VM, relay, or localhost.*

------

## Where to go from here:
- **Want to run it?** → [Typescript docs](https://neurons-me.github.io/monad/Typescript/)
- **Want to understand the protocol?** → [NRP - Namespace Resolution Protocol](https://neurons-me.github.io/NRP/)
- **Want to build an app on top of this?** → [this.me on npm](https://npmjs.com/package/this.me)
- **Want to understand the big picture?** → [neurons.me](https://neurons.me/)
- **How does the mesh pick a live monad?** → [Subtractive Synthesis](https://neurons-me.github.io/monad/Typescript/typedocs/Subtractive-Synthesis.html)

------

[Github Home](https://neurons-me.github.io)

**MIT —** [neurons.me](https://neurons.me)

**Author:** [suiGn](https://suign.github.io/)

<img src="https://res.cloudinary.com/dkwnxf6gm/image/upload/v1760629064/neurons.me_b50f6a.png" alt="neurons.me Logo" width="89"/>
