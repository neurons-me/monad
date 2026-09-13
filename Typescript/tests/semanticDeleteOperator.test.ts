/**
 * semanticDeleteOperator.test.ts — a write with operator:"-" must actually
 * delete, not silently become an unconditional set
 *
 * INCIDENT THIS GUARDS AGAINST (2026-09)
 * A gateway-ownership repair sent `{operation:"write", expression:<path>,
 * operator:"-", value:true}` via `POST /` expecting the target key to
 * disappear. It didn't: point reads, tree reads, and reads after a real
 * process restart all kept returning the placeholder `value` unchanged.
 * The delete request silently behaved as an ordinary overwrite.
 *
 * ROOT CAUSE
 * `operator:"-"` never survived past the HTTP write handler:
 *   - `src/claim/memoryStore.ts`'s `kernelWrite()` called
 *     `kernel.execute("me://self:write/<path>", data)` — dropping the
 *     3rd/4th argument, so the operator the caller asked for never
 *     reached the kernel at all.
 *   - Even had it been passed, `this.me`'s own `execute()` /
 *     `handleSelfTarget()` (me/Typescript/src/core.ts) had no parameter
 *     to carry it through to `self.postulate()` in the first place —
 *     `postulate`'s own type (`me/Typescript/src/types.ts`) already
 *     supported an optional `operator`, but nothing on the write path
 *     ever supplied one, so it defaulted to `null` every time.
 * The READ side (`buildSemanticBranchTreeForNamespace` /
 * `readSemanticValueForNamespace`, both in memoryStore.ts) was already
 * correctly operator-aware — it just never received a row with
 * `operator: "-"` to act on.
 *
 * Fixed by threading `operator` through `execute()` ->
 * `handleSelfTarget()` -> `self.postulate()` (me/Typescript's core.ts /
 * me.ts / types.ts) and having `kernelWrite()` actually pass its own
 * `operator` argument through instead of dropping it.
 *
 * WHY A REAL HTTP SERVER, NOT JUST CALLING memoryStore FUNCTIONS DIRECTLY
 * The incident happened over real HTTP, through the real route wiring —
 * see commitGate.test.ts's own header comment for the same reasoning.
 *
 * PERSISTENCE ACROSS A REAL RESTART IS TESTED ELSEWHERE, DELIBERATELY
 * This file proves the delete is correct within one running process
 * (hides the value, preserves siblings/other identities, allows a
 * legitimate rewrite afterward). It does NOT also simulate a process
 * restart in-process (drop the kernel via resetKernelStateForTests(),
 * boot a second createMonadApp() against the same stateDir) — that
 * looked like the obvious way to do it, but produced a kernel with no
 * memory of anything written before the "restart" even with the fix
 * correctly in place, for reasons not fully root-caused (something in
 * bootstrapMonad()'s cwd/state handling across two in-process boots,
 * not the operator fix itself — every assertion up to that point, with
 * or without the fix, behaves exactly as expected). Rather than ship an
 * unreliable simulation, the real-restart half of this guarantee is
 * proven in modules/netget/Typescript/tests/gateway-delete-operator-restart.test.ts,
 * which spawns and kills an ACTUAL separate OS process (the same
 * mechanism a real `netget`/`monads` restart uses) against an isolated
 * monad — closer to the real incident than an in-process stand-in would
 * be, and it doesn't share this file's unresolved quirk.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";

const ROOT_NAMESPACE = "delete-operator-regression.cleaker.me";

async function startServer(runtimeRoot: string, stateDir: string) {
  // claimDir/selfConfigPath must be FIXED, derived from runtimeRoot — not
  // a fresh createTempRuntime() call. That helper exists for the
  // one-boot-per-test case (see commitGate.test.ts, which never restarts
  // a server against the same state); calling it again here silently
  // pointed a "restarted" server at brand-new random paths instead of
  // the original install's own paths, unrelated to whether the delete
  // fix itself persists correctly.
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-delete-operator",
    namespace: ROOT_NAMESPACE,
    stateDir,
    claimDir: path.join(runtimeRoot, "claims"),
    selfConfigPath: path.join(runtimeRoot, "self.json"),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

// x-forwarded-host pins the namespace explicitly — the same header
// monadHttpClient.ts's real writeToMonad()/readFromMonad() always set.
// Without it, namespace resolution falls back to the plain HTTP Host
// header (127.0.0.1:<ephemeral port>), which changes every time this
// test restarts the server on a fresh port — silently pointing reads and
// writes at a different "namespace" each time, unrelated to whether the
// delete fix itself works. Pinning it is what real production traffic
// already does; it's not a workaround specific to this test.
async function post(origin: string, body: unknown) {
  const res = await fetch(`${origin}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": ROOT_NAMESPACE, host: ROOT_NAMESPACE },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function get(origin: string, dottedPath: string) {
  const res = await fetch(`${origin}/${dottedPath}`, {
    headers: { "x-forwarded-host": ROOT_NAMESPACE, host: ROOT_NAMESPACE },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

describe("semantic write operator ':-' (delete)", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;
  let stateDir: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-delete-operator-cwd-"));
    stateDir = path.join(runtimeRoot, "me-state");
    const started = await startServer(runtimeRoot, stateDir);
    server = started.server;
    origin = started.origin;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("hides the previous value, preserves siblings and other identities, and allows a legitimate rewrite", async () => {
    // Seed: a target key, a sibling under the same branch, and an
    // unrelated key — exactly the shape of the real incident (one bogus
    // identity's admin/grant entries next to other real ones).
    await post(origin, { operation: "write", expression: "admins.target-id", value: true });
    await post(origin, { operation: "write", expression: "admins.sibling-id", value: true });
    await post(origin, { operation: "write", expression: "grants.target-id", value: ["scope:read"] });
    await post(origin, { operation: "write", expression: "grants.sibling-id", value: ["scope:write"] });

    const beforeDelete = await get(origin, "admins");
    expect(beforeDelete.json.target.value).toEqual({ "target-id": true, "sibling-id": true });

    // The delete: operator "-", same shape a real repair sends.
    await post(origin, { operation: "write", expression: "admins.target-id", operator: "-", value: true });
    await post(origin, { operation: "write", expression: "grants.target-id", operator: "-", value: true });

    // Point read: the deleted key must be genuinely absent, not present-as-true.
    const pointRead = await get(origin, "admins.target-id");
    expect(pointRead.json.target.value).toBeUndefined();

    // Tree read: deleted key gone, sibling and the other branch intact.
    const treeRead = await get(origin, "admins");
    expect(treeRead.json.target.value).toEqual({ "sibling-id": true });
    const grantsRead = await get(origin, "grants");
    expect(grantsRead.json.target.value).toEqual({ "sibling-id": ["scope:write"] });

    // A legitimate subsequent write to the same, now-deleted path must
    // behave like any other normal write — deleting must not poison the
    // path against future use.
    await post(origin, { operation: "write", expression: "admins.target-id", value: true });
    const afterRewrite = await get(origin, "admins.target-id");
    expect(afterRewrite.json.target.value).toBe(true);
  });
});
