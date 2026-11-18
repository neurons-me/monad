# Monad control orders through .me

Status: **proposal.** Follows from SN5 of `local-supervisor.md`, the local supervisor contract, which is on the
`dev/agent-local` branch together with the supervisor and is **not on `main` yet**; references to it below point
there. On `main`, only §6 (HTTP orders closed) is implemented.
v1 written 2026-11-17; **v2 the same day**, after a review that approved the principle (signatures and grants
derived from the tree) and asked to close five execution gaps first (§12). **v2.1**: §6 option (a) approved and
implemented locally (HTTP orders closed, uncommitted); the attestation of §3.2 is **not approved** as the
mechanism (§3.2 now says why); D8 needs an explicit decision.

## 0. The rule

Controlling a monad from anywhere is a goal, not a hole. What must change is **who decides**: today the
`/__monads` guard decides from the `Host` and `Origin` headers, which the caller writes. Here the decision comes
from `.me`: **who signed the order, and what the tree grants that identity**. The path the request took (loopback,
LAN, nginx, another continent) stops mattering.

> Access is a derivation of tree state per identity; the door never changes it.

## 1. Facts from the code (2026-11-17)

| Fact | Where |
|---|---|
| The guard passes a request when `Host` looks local (`""`, `localhost`, `127.x`, `::1`, `0.0.0.0`, `*.local`) and `Origin` is absent or looks local. It never reads the socket address. | `src/http/monadsControl.ts` `localControlGuard` |
| Every monad mounts this router, and it acts on **every** record under `MONADS_HOME`, not only its own. | `src/app.ts:174` |
| The monad listens on every interface (`app.listen(port)`). | `src/index.ts:115` |
| Disposable probe (`tests/sn5ControlGuard.probe.test.ts`, uncommitted): forged `Host: localhost` from the LAN address, `Host: *.local`, no `Host`, `Origin: http://printer.local`, `Origin: http://localhost:5173` all reach the order handler. `Origin: null` and foreign `Host`/`Origin` are refused. | probe |
| `POST /__monads/start` **creates** a record. `/:name/start`, `/resume` and `/restart` accept `port` and `namespace` and pass them on (`options.namespace \|\| existing.namespace`): starting an existing monad can change its namespace. | `monadsControl.ts:154-183`, `runtime.ts:729-770` |
| nginx `/monads/<name>/…` overrides `Host` to the target's namespace when one is registered, else forwards the client's `Host`. Not proven by a test. | local OpenResty `monad_proxy.lua` |
| The `all.this` browser UI sends orders over HTTP (`/__monads/start`, per-monad actions) and reads `/__monads`, `/status`, `/logs`. | `all.this/src/npm/src/boot/browser-entry.ts` |
| v2 agent proofs: `me-proof/2` + canonical JSON signed by an agent key at `keychain.agent.<keyId>`; `op: "call"` binds `kind`, `namespace`, `method`, `path`, `bodyHash`, `nonce`, `issuedAt/expiresAt`, `origin`, `audience`; header `x-me-proof`. | `src/claim/agentProof.ts`, `src/http/agentRoutes.ts` |
| The v2 nonce store is **in memory**; after a restart, proofs issued before the process started are refused (R15). | `agentProof.ts` `reserveAgentNonce` |
| Claims and agent keys are read **synchronously from the local kernel** of the monad that holds that namespace (`getAgentKey` → `readSemanticValueForNamespace`). For a local sibling that is usually **another process**; for a namespace served elsewhere, another machine. | `src/claim/agentAuthority.ts:40` |
| local-supervisor.md: "the root itself is not a record: it is the OS service". | local-supervisor.md §4 |
| Node grants (executor key, `(namespace, nodePath, operations)`, signed exact params, live revocation, granter's capability re-read on use) exist on `origin/feat/node-grants`, **not merged**. | that branch |

## 2. Model

### 2.1 The root

The root is **the OS service** (one per `MONADS_HOME`), as local-supervisor.md already says. It is not a monad
record and no order can address it. v1's D6 ("a record marked as root") is withdrawn.

- **Exclusion:** at start the root takes a home-level lock, `MONADS_HOME/root.lock` (directory created with mkdir,
  owner `{pid, processStartedAt, token}`, the same rules as the record lock: a live or unverifiable owner is
  waited for, a dead one reclaimed). A second `monads supervise` on the same home refuses to start.
- **Stable identity:** on first start the root writes `MONADS_HOME/root.json` `{ rootId }` (random, never
  rewritten). `rootId` is the `audience` of every order. Moving or copying the home keeps the id; deleting
  `root.json` makes a new root, and proofs addressed to the old one stop matching.
- **The root answers orders**: it serves the order endpoint itself (a small HTTP listener inside the service).
  Sibling monads stop serving `/__monads` orders and answer `NOT_THE_ROOT` with the root's endpoint.
- **Stopping or removing the root** is an OS action (`systemctl stop`, uninstall), never an order.

### 2.2 Who owns a monad, and where that is read

The **owner of a monad** is the identity holding the claim of the namespace in its record. A namespace with no
claim has no owner on the network: no network order for its monads (fail closed).

The claim and the owner's agent keys live in the kernel of **the monad that holds that namespace** (§1), usually
not the root. So the root never reads authority "live" in its own memory. It obtains an **authority attestation**
(§3.2) from that monad. This is what makes the acceptance point (§3.3) well defined across processes.

### 2.3 Four kinds of call, not one

| `kind` | What | Who may sign | Body (exactly these fields) |
|---|---|---|---|
| `monad.create` | New record | The owner of the namespace being created | `{ root, monad, namespace, port? }` |
| `monad.order` | `start`, `on`, `off`, `pause`, `resume`, `restart`, `stop`, `recovery-on`, `recovery-off`, `delete` on an existing record | Its owner (or a grantee, §4) | `{ root, monad, order }` and nothing else |
| `monad.configure` | Change `port` | Its owner | `{ root, monad, port }` |
| `monad.reassign` | Change `namespace` (that is, ownership) | **Both** the current owner and the owner of the new namespace: two proofs over the same body | `{ root, monad, from, to }` |

An order body that carries `port` or `namespace` is refused (`FIELD_NOT_ALLOWED`). The runtime's
`options.namespace || existing.namespace` path is closed for HTTP: only `monad.reassign` changes a namespace, and
only `monad.create` makes a record. The CLI keeps its flags (local operator, §2.4).

### 2.4 The local operator

A process that can write `~/.monad/monads/<name>/monad.json` already has OS-level authority (local-supervisor.md
S3). The CLI acts through the files and needs no signature. HTTP never gets a local exemption in the final state,
not even from loopback: a web page open on any `localhost` port is a loopback caller too.

### 2.5 Reads

list, status, logs: what the tree grants the reader (D1). Not part of the execution rules below.

## 3. Executing a signed call

### 3.1 The durable order id

`orderId = sha256(the exact signed bytes)`. It identifies the call across retries, restarts and lost responses.
The nonce stays inside the signed bytes (so two calls with the same body differ), but **replay protection for
orders uses the journal (§5), not the in-memory nonce store**, because the store is empty after a restart.

### 3.2 The authority attestation (candidate, not approved)

The root needs the owner's current authority, which lives in another process (§2.2). The candidate is an
**attestation**: the root asks the monad that holds the namespace for

```
{ namespace, claimed, ownerIdentityHash, key: { keyId, status }, grant?: {...}, rootChallenge, signature }
```

signed by that monad's key. Two problems keep it from being approved:

**A1. Who may attest.** A signature only says which key signed. The root must know that this key speaks for the
namespace's authority. "Pin it at `monad.create`" moves the question, it does not answer it: at create time the
root has the same problem. The trust has to derive from the namespace's claim (for example, the claim or an agent
key of the owner signing a statement that names the attesting monad's key, revocable like any key). That is the
same open question as mesh trust, and this contract does not close it.

**A2. Stale authorization window.** Whatever the attestation says was true when the attester read it. A
revocation committed **after that read and before the root's fsync at step 10 can still be accepted**. That is
not "a revocation that happened after acceptance": it is an acceptance on stale authority, and the contract names
it so. Its length must be bounded and measured without trusting clocks:

- the root sends a fresh random `rootChallenge` with the request and starts a **monotonic** timer;
- the attester signs the challenge with its answer (so the answer cannot predate the request);
- the root accepts only if `monotonic(fsync at step 10) - monotonic(request sent) <= STALE_WINDOW_MAX` (D7), and
  otherwise refuses with `AUTHORITY_STALE` and writes nothing.

So the window is at most `STALE_WINDOW_MAX`, measured on the root's own monotonic clock. Clock skew between
machines does not enter (no timestamp from one clock is compared with another); network delay and a slow attester
use up the budget instead of extending the window. A revocation that must take effect immediately cannot get that
guarantee from an attestation; it needs the root to be the deciding authority itself, or a protocol that
orders authority updates against acceptances (D8).

If the namespace's monad does not answer, there is no attestation and the call is refused
(`AUTHORITY_UNAVAILABLE`). That is the circular dependency of D8.

### 3.3 The acceptance point

Everything that can change the decision is read **inside the record lock**, and the call is accepted by one
durable write, also inside it. An order that was already accepted is recognized right after authentication, before
anything about the target is read, so retries keep working after the target changed (§5.2).

```
outside the lock  (may only REFUSE, never accept)
  1. parse strictly; kind known; body has exactly its fields; path and body agree     failedAt: "parse"
  2. audience == this rootId; time window valid                                         failedAt: "audience"
  3. authenticate: read the signer's key state only (the minimum needed to authenticate, §3.2, mechanism open);
     the key exists and is active, and the signature over the exact bytes is valid     failedAt: "signature"
  4. orderId already in the journal?  -> ALREADY_ACCEPTED { orderId }: no execution, no outcome (§5.2)
     (read from the home journal, no record lock, nothing about the target read)

inside the record lock  (for monad.create: the home lock, the name does not exist yet)
  5. re-check the signer's key is still active (it may have been revoked while waiting for the lock)
                                                                                        failedAt: "signature"
  6. re-read the record (exists for order/configure/reassign; absent for create)       failedAt: "record"
  7. the record's namespace == the proof's namespace                                    failedAt: "namespace"
  8. authority: the namespace is claimed, and the signer is its owner or holds a live grant covering
     (order, monad)                                                                     failedAt: "authority"
  9. orderId in the journal now?  -> ALREADY_ACCEPTED (a concurrent identical request got there first)
 10. ACCEPT = append { orderId, kind, body, identityHash, keyId, grantId?, authorityReadMs, state: "accepted" }
     to the journal and fsync.            <-- the acceptance point, and the only place an order's nonce is reserved
 11. apply (the same runtime function the CLI uses, already holding the lock)
 12. append { orderId, state: "applied" | "failed", error? } and fsync
release the lock
 13. project the journal entry to the tree (§5.3)
```

**What is read before authentication.** Only what authenticating needs: the signer's key and its status. Not the
target record, not the target namespace's claim or grants, not the journal. An unauthenticated request takes no
record lock (it cannot create a runtime directory or hold up a real order), burns no nonce and writes nothing.

**Nothing before step 10 changes state.** Two concurrent identical requests: one reaches step 10, the other is
answered `ALREADY_ACCEPTED` at step 4 or step 9.

**A signed proof is a bearer artifact.** Whoever holds the complete request, signature included, can resend it;
the signature proves who signed, not who is sending. The contract limits what holding it gives:

- resending it never executes the order again and never returns its outcome, only `ALREADY_ACCEPTED`;
- the outcome is read with a separate, fresh, single-use call (§5.2), so reading it needs the signer's key now;
- outside loopback, orders travel only over TLS, so the request is not readable in transit.

What stays possible: someone who obtains a valid request **before** it reaches the root can submit it first. That
executes exactly what the signer signed, for this root, within its validity window; it is not prevented here, only
bounded by audience and TTL.

### 3.4 Internal diagnosis and public answers

> **Do not reveal authorization decisions before authenticating. Internal diagnostics do not imply public
> exposure.**

- **Internal:** every refusal records its `failedAt` step and the specific reason (unknown key, revoked key, bad
  signature, no record, namespace mismatch, not owner, grant does not cover…), in the server's own logs and in a
  test-visible decision trace. Tests assert on these.
- **Public, before authentication (steps 1-3):** a malformed call may be told it is malformed (`PROOF_MALFORMED`:
  nothing protected in that). Everything else gets one answer, `UNAUTHENTICATED`, whether the key is unknown,
  revoked or the signature is wrong, and whatever exists on this root.
- **Public, after authentication (steps 4-9):** what the caller may learn depends on the read policy (D1). Until D1
  says otherwise, a caller with no authority over the named monad gets `NOT_AUTHORIZED` both when the monad exists
  and when it does not (`NOT_FOUND` only to callers allowed to read it), so authenticating is not a way to list
  another owner's monads. The owner and its grantees get the specific reason.

For `monad.reassign` both proofs go through steps 3-8, both attestations must be fresh, and the root pins the
new namespace's monad key in the same journal write.

## 4. Delegation (node grants)

The owner grants a program (panel, phone, another machine's agent) `nodePath: "monads.<name>"` (or `"monads"`),
`operations: [...]`, the executor's own key, optional expiry. The executor signs the concrete call with its own
key. At step 8 the authority state carries the grant **and** the granter's current ownership: if the owner lost the
namespace, every grant it issued stops at the next use. AND, never OR. A grant never covers `monad.create`,
`monad.reassign` or `delete` unless it names them explicitly (D9).

Needs `feat/node-grants` merged first (D4).

## 5. The journal and recovery

### 5.1 Where

`MONADS_HOME/orders.journal` — append-only JSON lines, one file per home, owned by the root, fsync'd at steps 10
and 12. Home-level (not per record) because `delete` removes the record's directory. Bounded: entries older than
the longest proof TTL plus a margin are compacted into a summary, never silently dropped (D2).

### 5.2 Retries and lost responses

Two separate things, so that neither depends on the target still being as it was:

- **Resending the same proof** (the client does not know whether it arrived) is answered at step 4 with
  `ALREADY_ACCEPTED { orderId }` once the order is in the journal, before the record, namespace or authority are
  read. It works after a successful `delete` (the record is gone) and after a `reassign` (the signer is no longer
  the owner). It never executes again and carries no outcome.
- **Reading the outcome** is its own call, `kind: "monad.order.result"`, body `{ root, orderId }`, signed fresh
  (new nonce). Rules:
  - authenticate the signer as in step 3 (its key active **now**; an identity whose signing key was revoked uses
    another active key of the same identity);
  - the signer's `identityHash` must equal the one recorded in the journal entry (for a delegated order, the
    executor's);
  - the record, the namespace's current ownership and any grant are **not** required: the question is "what
    happened to the order I signed", not "may I act on this monad now";
  - the answer is `applied`, `failed` (with the error) or `in-progress`; an unknown orderId and another identity's
    orderId get the same `NOT_FOUND`;
  - the query's nonce is single-use (reserved when answered), so a captured query cannot be replayed to read the
    outcome again.
- A client that wants the order done again signs a new call (new nonce, new orderId).

### 5.3 The tree projection

After step 12 the root writes the entry to its tree as `monads.<name>.orders.<orderId>`. Keyed by orderId, so
writing it twice is a no-op. That makes "one memory per accepted order" hold even with crashes: the projection is
at-least-once, the key makes it once. `monads.*` is reserved: generic write surfaces refuse it.

### 5.4 Crash points

| The root dies… | On restart the root finds… | It does |
|---|---|---|
| before step 10 | nothing in the journal | nothing; the call was never accepted; the client may resend (same proof is still valid if unexpired) |
| between 10 and 11 (accepted, not applied) | `accepted` with no outcome | **does not run it blindly.** For `on/off/pause/resume/start/stop/recovery-*` it checks the record: if `desired` already matches the order, marks `applied (recovered)`; if not, marks `failed (interrupted)`. `restart` and `delete` are never re-run: `failed (interrupted)`, or `applied (recovered)` if the record shows it happened (delete: the record is gone). |
| during 11 (e.g. `desired` written, process not yet started) | `accepted`; `desired` already changed | `applied (recovered)`; the supervisor converges the process to `desired` as it always does (local-supervisor.md) |
| between 12 and 13 | outcome written, no tree memory | writes the projection (§5.3); idempotent |
| during 13 | partial or no projection | same; idempotent by orderId |

The rule behind the table: **`desired` is the intent, and the supervisor converges to it**, so for intent-setting
orders "was it applied" reduces to "does `desired` say so". Only the non-idempotent orders (`restart`, `delete`,
`create`, `reassign`) need the record to show it, and are otherwise reported `failed (interrupted)` for the
client to decide.

## 6. Transitional measure (before §3 exists)

This is **provisional hardening, not a guarantee**: a loopback socket without forwarding headers does not prove
the request started on this machine, because a local proxy can drop those headers, and the nginx paths are not
verified (§1).

Two options (D10):

- **(a) Close HTTP orders now.** `/__monads` order routes answer `ORDERS_DISABLED`; reads stay; the CLI keeps
  working. Strong and simple. Cost: the `all.this` browser UI loses its order buttons until §3 ships.
- **(b) Harden.** Orders only when the socket is loopback, there is no `X-Forwarded-For`/`X-Real-IP`, and
  `Origin` is absent or exactly this monad's own origin; `Host` `""`, `0.0.0.0`, `*.local` stop counting as
  local. Only valid **after** checking every entry path to the monad ports on this machine (nginx blocks, any
  other local proxy, dev servers that proxy). Cost: keeps a door whose strength depends on that inventory.

Proposal: **(a)**. The order buttons come back with §3, signed.

### 6.1 Applied (2026-11-17, option a approved)

- `src/http/monadsControl.ts`: `refuseHttpOrders` runs first under `/__monads`, before the header guard, and
  refuses every method other than GET/HEAD/OPTIONS with `403 ORDERS_DISABLED`, on every path: current routes, the
  older aliases (`stop`, `start`, `resume`, `POST /:name/delete`, `DELETE /:name`) and any path added later. Reads
  are unchanged. `GET /__monads` advertises orders as CLI-only (`method: "CLI"`, empty `path`, the convention the
  `proxy` action already used) and adds `command.orders = { enabled: false, error, message }`.
- `all.this/src/npm/src/boot/browser-entry.ts`: a CLI-only action renders as a disabled button with no click
  handler, and the card shows one line: orders from the web are paused until signed with the `.me` identity; use
  the `monads` CLI, with an example. Status, Logs and Rescan stay enabled. Works through both ways the UI gets the
  control (direct `/__monads` read, and GUI discovery, which keeps `method`).
- Tests on `main`: `tests/httpOrdersClosed.test.ts` (5) on a disposable home with a stand-in monad (a sleeping
  process and a hand-written record; `main` has no supervisor): 15 order requests (all routes, old aliases,
  PUT/PATCH, unknown paths) refused with the process alive and the record byte-identical, and no new record;
  CN1–CN3 header variants incl. the LAN address and no `Host`; reads 200; CLI-only advertisement; the `monads`
  command itself, run as its own process from source with `tsx`, still turns a monad off. The built `dist/` binary
  was not run. Removing the middleware makes the 2 order tests fail. (On `dev/agent-local` the same file has 6
  tests on the supervisor's stand-in monads.) The UI was checked by rendering the card from a disposable server's
  real payload through both paths (scratch harness, not committed): order buttons disabled without handlers,
  explanation present, server still refuses a direct call.
- Scope: released on `main` (`be840997`); not deployed. **Monads already running elsewhere (the VM, any other
  checkout) still serve the old routes until this code is deployed there.** An older `all.this` UI still shows
  enabled buttons; the server refuses them and the UI shows the error.

## 7. Invariants

| # | Invariant | Tested by |
|---|---|---|
| C1 | No `Host`, `Origin` or other caller-written header authorizes a call. | CN1–CN3 |
| C2 | A call is accepted only at step 10, after every authority check inside the record lock; nothing before step 10 changes state. | CN4–CN9, CN17, CN20 |
| C3 | The server decides the capability; the request never names it. Order bodies carry only `{root, monad, order}`. | CN10, CN19 |
| C4 | Only the root answers, only for records under its home, and nothing can order the root itself. | CN11, CN12, CN22 |
| C5 | An unclaimed namespace accepts no network call; creating and reassigning are separate kinds with their own signers. | CN13, CN18, CN19 |
| C6 | Each accepted call has exactly one journal acceptance, at most one outcome, and exactly one tree projection keyed by orderId. | CN14, CN21 |
| C7 | The same proof never executes twice; a retry gets the recorded outcome. | CN8, CN20 |
| C8 | The authority used was read at most `STALE_WINDOW_MAX` before acceptance, measured on the root's monotonic clock; a revocation inside that window may be accepted, and the contract says so. | CN16, CN17, CN23 |
| C9 | The CLI keeps working with HTTP orders closed. | CN15 |
| C10 | **Recognizing a signer is not obeying it.** Without applicable authority (ownership of the namespace, or a delegation that covers this order on this monad) the order is refused, however valid everything else is. Authority in one scope (gateway admin) never carries over to another (monads). | CN25, CN25b |
| C11 | **Before authentication, only the signer's key state is read**, never the target record, the target namespace's claim or grants, or the journal; and no response reveals protected information or an authorization decision. Internal diagnosis (`failedAt`) is never the public answer by itself. An unauthenticated request never takes a record lock, burns a nonce or writes. Scope: what CN26–CN28 check, the **content** of responses and the absence of writes; timing and other side channels are not covered (§11). | CN26–CN28 |
| C12 | **Retries and results do not depend on the target's current state.** A resent proof of an accepted order is recognized before the record, namespace or authority are read; its outcome is read only with a fresh single-use query by the identity that signed it. Resending a proof never re-executes and never returns the outcome. | CN28–CN31 |

## 8. Negative tests

### The jewel: being gateway admin does not grant control of monads

Accepting an order answers three separate questions:

| Question | What proves it |
|---|---|
| Who is asking? | A valid signature by a key bound to that identity |
| May they do this action on this resource? | The owner's authority (from the claim) or a delegation that covers it |
| Is this concrete request admissible now? | Right destination (root), validity window, replay protection, and the rest of §3.3 |

A signature protects the request and identifies the signer. **It does not make permissions.** Signing "turn off
someone else's monad" only proves who asked.

The jewel makes **everything valid except the authorization**: Ana has an active key, signs correctly, uses a fresh
nonce, sends `off` to the right root, and is admin of the gateway; she is not the monad's owner and holds no
delegation for it. The order is refused **without stopping the process or changing `desired`**.

Why it is the one test that cannot regress: a test with a bad signature is refused before authorization is ever
checked, so it passes without telling whether authorization works. The jewel forces the server all the way to that
decision. CN6 and CN10 also test authorization; the jewel adds the case that matters most here, authority valid in
one scope (gateway) leaking into another (monads).

Two precisions: the owner needs no extra grant (its authority comes from the claim), so the rule is "no applicable
authority ⇒ refused", whether that authority would come from ownership or from delegation. And refusing is not
enough on its own: the positive control (CN25b) shows the system tells permissions apart instead of refusing
everything.

Two rules keep these tests honest:

- **Refused for the right reason.** An error code alone does not show where a call failed. Every refusal carries
  the step that refused it (`failedAt`, in the order of §3.3: `parse`, `audience`, `signature`, `record`,
  `namespace`, `authority`). `failedAt` is internal diagnosis (§3.4), not part of the public answer, and CN25/CN25b assert both that step and that all earlier ones passed.
- **One proof per attempt.** Reusing the `off m` proof for `delete m` or `off n` would be refused by signature,
  destination or replay, never reaching the permission's scope. Each attempt is signed fresh.

Not being in the orders journal (accepted calls only) does not stop a refusal from being written to a separate
security log. That log is a different thing from the journal and is not specified here.

**Status:** these tests are **specified, not demonstrated**. Nothing in §3–§4 is implemented yet.

| # | Attempt | Expected |
|---|---|---|
| **CN25** | **The jewel.** Ana: active agent key, valid v2 proof, fresh nonce, audience = this root, `off` on monad `m`; gateway admin; not the owner of `m`'s namespace; no delegation. **Every other requirement is also valid**: the record exists under this root, the namespace is claimed, a fresh attestation from an attester the namespace's authority names, time window and body correct. | refused at the **authorization** step and nowhere earlier: the decision trace reports `failedAt: "authority"` and the test asserts that every earlier step passed (a test-visible decision trace, not the error code alone); `m`'s PID, start time and `desired` unchanged; no entry in the orders journal; nonce not burned |
| **CN26** | Unauthenticated calls (unknown key; revoked key; bad signature) naming an existing monad, a non-existent one, and an unclaimed namespace | every combination answers the same `UNAUTHENTICATED`; internal trace has the real reason; no lock directory created for the non-existent name |
| **CN27** | Authenticated caller with no authority over monad `x`: `off` on an existing `x` and on a non-existent `y` | both `NOT_AUTHORIZED`, indistinguishable; only a caller whom D1 allows to read this root's records gets `NOT_FOUND` for `y` |
| **CN28** | Someone holding the exact signed bytes of an accepted order: (a) resends them with a wrong signature; (b) resends them **unchanged** (valid signature, not the signer) | (a) `UNAUTHENTICATED`; (b) `ALREADY_ACCEPTED { orderId }` only: no second execution, no outcome; in both, journal and nonce untouched |
| **CN29** | `delete m` applied, response lost; the client resends the same proof; then reads the result with a fresh `monad.order.result` | resend: `ALREADY_ACCEPTED` although `m` no longer exists; result: `applied` |
| **CN30** | `reassign m` applied (the signer is no longer the owner); same resend and result query by the original signer | resend: `ALREADY_ACCEPTED`; result: `applied`, without the signer being owner now |
| **CN31** | Result query for an orderId by another identity; for an unknown orderId; and the same query proof sent twice | first two: the same `NOT_FOUND`; the repeated query: refused (single-use nonce), outcome not returned again |
| **CN25b** | **Positive control.** The owner then delegates to Ana only `off` on `m`. Ana sends three calls, **each with its own new proof and nonce, and its own path and body**: `off` on `m`; `delete` on `m`; `off` on another monad `n` of the same owner | `off m` applied; `delete m` and `off n` refused at the authorization step (`failedAt: "authority"`, `NOT_GRANTED`), not by signature, destination or replay |

### All the others

All on a disposable `MONADS_HOME`, real router, fake monads (as in `localSupervisor.test.ts`).

Transitional (§6):

| # | Attempt | Expected |
|---|---|---|
| CN1 | Order from the LAN address with forged `Host: localhost` | refused |
| CN2 | `Host: anything.local`, or no `Host` (HTTP/1.0) | refused |
| CN3 | From loopback with `Origin: http://printer.local`, `Origin: http://localhost:<other port>`, or `X-Forwarded-For` | refused (option a: every order refused) |

Signed (§3–§5):

| # | Attempt | Expected |
|---|---|---|
| CN4 | No proof, or a v1 proof | refused, no journal entry |
| CN5 | Proof by a revoked agent key | refused |
| CN6 | Proof by another identity's valid key | refused (`NOT_OWNER`) |
| CN7 | Valid `off` proof on the `on` route; proof for monad A on B's route | refused, both untouched |
| CN8 | Same proof sent twice, sequentially | second answers the first's outcome; executed once |
| CN9 | Audience is another root; or expired | refused; no journal entry |
| CN10 | Grant for `["status"]` used for `off` | refused (`NOT_GRANTED`) |
| CN11 | Valid order sent to a sibling | `NOT_THE_ROOT` |
| CN12 | Order naming a monad known only from the mesh index | refused |
| CN13 | Order for a monad whose namespace is unclaimed | refused |
| CN14 | Accepted order: one journal acceptance, one outcome, one projection; refused order: none; generic write to `monads.*`: refused | as stated |
| CN15 | `monads off <name>` from the CLI with HTTP orders closed | works |
| CN16 | Owner loses the namespace; a grant it issued earlier is used | refused |
| **CN17** | **Revocation while the order waits for the lock:** order A holds the lock; order B (valid key) waits; the key is revoked; A releases | B's attestation is taken after it gets the lock, sees the revocation, B refused |
| **CN18** | **Create without a record:** `monad.order start` for a name with no record | refused (`NOT_FOUND`); `monad.create` by the namespace's owner works; `monad.create` by someone else refused |
| **CN19** | **Namespace change:** `monad.order start` with `namespace` in the body; `monad.reassign` with one proof only; with both | refused (`FIELD_NOT_ALLOWED`); refused; applied |
| **CN20** | **Two concurrent requests with the same proof** | one executes; the other waits for the lock, then gets the same outcome; one journal acceptance |
| **CN21** | **Crash after writing `desired`, before the projection** (kill the root at step 11/12 with a hook) | on restart: `applied (recovered)`, one projection, `desired` and process converge |
| **CN22** | An order whose `monad` is the root, or a second `monads supervise` on the same home | refused (`NOT_A_RECORD`); second root refuses to start |
| **CN23** | Attester answers slower than `STALE_WINDOW_MAX`, answers an old challenge, or its clock is hours off | refused (`AUTHORITY_STALE` / `PROOF_INVALID`); clock skew alone changes nothing |
| **CN24** | Attestation signed by a key the namespace's authority never named | refused |

## 9. Decisions for the owner

| # | Question | Proposal |
|---|---|---|
| D1 | Who reads status and logs? | Owner and grantees by default; the owner can declare more readers in the tree. |
| D2 | Journal retention | Keep acceptances and outcomes; compact entries older than proof TTL + 1 day into a summary per record. |
| D3 | Move `desired` into the tree? | Later; it changes the supervisor's source of truth. |
| D4 | Merge `feat/node-grants` before delegation? | Yes, as its own reviewed step; §3 does not need it. |
| D5 | Bind monads to `127.0.0.1`? | No; with §3 the bind address stops being the defence. |
| D6 | (withdrawn in v2: the root is the OS service, §2.1) | — |
| D7 | `STALE_WINDOW_MAX` (§3.2 A2) | 5 s, on the root's monotonic clock. |
| D8 | **Circular dependency:** the verifier of the owner's authority is a monad; while it is down, the owner cannot start it remotely. This conflicts with the goal of remote control. | Needs an explicit decision. **(i)** Accept provisionally: remote start of a namespace's own monad is impossible while it is down; the CLI starts it. **(ii)** The root keeps a copy of the owner's claim and agent-key state, updated by signed messages from the owner, so it verifies without asking a monad that may be down. This removes the circular dependency, **not** the stale window: signatures prove an update is authentic, not that it is the latest, so the copy can lag a revocation. The window disappears only if the root is the deciding authority for that namespace (revocations decided where orders are accepted), or a protocol orders updates against acceptances (for example, a sequence number the owner signs on every update and every order must name). **(iii)** A second verifier: another monad of the owner holding the same namespace may attest. Proposal: (i) now as a written limit; (ii) designed together with mesh trust, with the stale-window question answered explicitly, not assumed away. |
| D11 | Who may attest (§3.2 A1) | Open, tied to mesh trust. No signed order ships before it is answered. |
| D9 | May a grant cover `create`, `reassign`, `delete`? | Only when named explicitly; never by `"monads"` alone. |
| D10 | Transitional measure | (a) close HTTP orders now; CLI stays. |

## 10. Order of work

1. ~~§6 option chosen in D10 + CN1–CN3, CN15.~~ **Done locally 2026-11-17** (§6.1).
2. Root service: home lock, `root.json`, order listener; siblings answer `NOT_THE_ROOT` (CN11, CN22).
3. Journal + acceptance point + recovery (§3.3, §5) with owner proofs, attestation from the namespace's monad
   (CN4–CN9, CN12–CN14, CN17–CN21, CN26–CN31, **CN25 the jewel**: no signed order ships without it).
4. After D4: delegation (§4) + CN10, CN16, CN25b (the jewel's positive control).
5. D1 read policy.

Nothing here touches the kernel, the VM or a real monad; every test runs on a disposable `MONADS_HOME`.

## 11. Not covered

- How the root pins and rotates the key of each namespace's monad beyond create/reassign.
- Calls whose namespace is served on another machine (the attestation route over the mesh; gated by the mesh-trust
  gap).
- A malicious process of the same OS user (local operator level, local-supervisor.md S3).
- **Timing and other side channels.** CN26–CN28 check what responses say and that nothing is written; they do not
  show that response times, lock contention or resource use reveal nothing. The disclosure guarantees (§3.4, C11)
  are limited to response content until such tests exist.
- **A valid request captured before it reaches the root** can be submitted by whoever holds it; it executes exactly
  what was signed, bounded by audience and TTL (§3.3). Preventing that needs channel binding, not covered here.

## 12. Changes from v1

| Review point | v2 |
|---|---|
| P1 authorization checked before the lock | All authority reads moved inside the record lock; acceptance is one fsync'd journal write (§3.3); concurrent revocation: v2 used `observedAt` and a freshness bound; v2.1 replaces it with a challenge and a monotonic stale window, and names the window (§3.2 A2). Also found: authority lives in another process, so "read live" needed the attestation. |
| P2 `start` mixes create, start, namespace change | Four kinds (§2.3); order bodies can't carry `port`/`namespace`; reassign needs both owners. |
| P3 crash between accept, apply, record | `orderId` = hash of signed bytes; home-level journal; retries answered from it; crash table (§5.4). |
| P4 transitional measure assumed proxy behaviour | Reframed as provisional; recommended option is closing HTTP orders (§6, D10). |
| P5 two definitions of the root | Root = OS service (as local-supervisor.md); home lock, stable `rootId`, never orderable (§2.1). D6 withdrawn. |
| Tests asked for | CN17–CN22. |
| Jewel review | Named test "the jewel" (CN25) + positive control (CN25b), invariant C10. Then: every refusal reports `failedAt`; CN25 has every other requirement valid and asserts it failed at authority; CN25b signs each attempt fresh; signature now verified (step 6) before authority (step 7); refusals may go to a separate security log; status "specified, not demonstrated". |
| Disclosure review | "Learns nothing" withdrawn as stated. Authentication moved first (step 3, outside the lock; key re-checked at 4), then record, namespace, authority; replay/retry lookup only after authentication (step 8); no early replay check; nonce reserved only at the acceptance point. §3.4: internal `failedAt` vs public answers (`UNAUTHENTICATED` before auth; after auth per D1, non-owners can't tell existing from missing). C11, CN26–CN28. |
| v2.1 review: who may attest; stale window vs revocation; D8 circularity | §3.2 marked not approved, A1 and A2 written out; challenge + monotonic `STALE_WINDOW_MAX` replace clock comparison; D8 options (i)–(iii); D11; CN23–CN24. |
| Retry / bearer review | Already-accepted orders recognized right after authentication (step 4), before record/namespace/authority, so `delete` and `reassign` retries work; outcome read by a separate fresh single-use `monad.order.result` call by the signing identity, not by resending; a signed proof stated as a bearer artifact (resend never re-executes, never returns the outcome; TLS outside loopback; pre-arrival capture named as not covered). "Reads no protected state" replaced by "reads only the signer's key state before authenticating". Disclosure guarantees limited to response content (timing not covered). Steps renumbered (acceptance = step 10). C11 reworded, C12, CN28 extended, CN29–CN31. |
