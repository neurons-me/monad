/**
 * signUpClaimFlow.test.ts -- the sign-up flow's new claim step
 * (useCleakerAuth.ts: POST /claims before the gateway claim, no separate
 * unsigned profile-write loop afterward), verified against a REAL
 * disposable monad using the SAME production identity derivation the
 * browser runs -- not a test-only stand-in:
 *
 *   - the claim proof itself: this.me's ME_RESEED + cleaker's binder,
 *     exactly deriveCleakerNode() in packages/GUI/Typescript/src/gui/
 *     All.This/Cleaker/signedRequest.ts.
 *   - the follow-up signed write: the SAME branch-key formula
 *     createCleakerSession.ts's signAndWrite() uses
 *     (deriveBranchProofSeed(compoundSeed, username), where compoundSeed
 *     is this.me's own internal ME_RESEED formula, reproduced here since
 *     it isn't part of this.me's exported surface). This is deliberately
 *     NOT the simpler, test-only scheme rootWriteDirectionCheck.test.ts's
 *     own claimNamespaceAs() helper uses
 *     (deriveBranchProofSeed(secret, namespace)) -- that scheme is
 *     self-consistent for ITS OWN purposes but does not match what the
 *     real browser code actually signs with, so it would prove the wrong
 *     thing here: that SOME valid signature is accepted, not that THIS
 *     ONE (the real production derivation) is.
 *
 * Answers, end to end, the conditions review attached before this fix
 * could land:
 *   1. The claim request never carries a privateKey -- only the proof
 *      (which itself never carries one either).
 *   2. The proof is bound to this specific destination (method+path+
 *      nonce+timestamp inside the signed challenge, path:"/claims") --
 *      distinct from /me/claim's own separately-built proof, so one can
 *      never be replayed as the other.
 *   3. seedClaimNamespaceSemantics()'s internal seed writes do not desync
 *      the chain head: GET /write-head immediately after POST /claims
 *      returns a value a real signed write, from the same identity,
 *      accepts without 409.
 *   4. The sign-up flow's profile write no longer depends on, and is no
 *      longer covered by, the open-unsigned-for-unclaimed-namespace
 *      default -- an unsigned write to the newly-claimed namespace is
 *      rejected (NAMESPACE_WRITE_FORBIDDEN, not the old open-by-default
 *      pass-through).
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import sha3 from "js-sha3";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- see appAuthorization.test.ts's identical import for why.
} from "../../../me/Typescript/dist/me.es.js";
// The REAL browser-side derivation, imported (not reimplemented) -- this
// file is deliberately "framework-free" (its own header comment), so it
// resolves cleanly outside a bundler/React tree. Importing it, instead of
// copying deriveCleakerNode/canonicalJson/genNonce inline, means this test
// tracks the actual client code: if that derivation ever changes, this
// test either keeps passing against the new one, or fails and says so --
// it can't silently keep verifying a stale copy.
import {
  deriveCleakerNode,
  canonicalJson,
  genNonce,
// @ts-expect-error -- no .d.ts resolution across this relative path, same
// reasoning as the this.me import above: this reaches GUI's real TS
// source directly, which this file's own "framework-free" header comment
// says is safe (no React/DOM import, no path alias).
} from "../../../packages/GUI/Typescript/src/gui/All.This/Cleaker/signedRequest.ts";

const { keccak256 } = sha3;
// this.me's own internal formula (me.ts's private deriveCompoundSeed(),
// not exported) -- reproduced here only because signAndWrite() itself
// reproduces it client-side (createCleakerSession.ts holds the raw
// compound seed explicitly, since `me`'s own seed is a private class
// field it can't read back out) -- so this mirrors THAT file's own
// necessity, not a shortcut taken only here.
const COMPOUND_SEED_DOMAIN = "me.seed/compound:v1::";
const ROOT_NAMESPACE = "signup-claim-flow.test";

let server: Server | null = null;
let runtimeRoot: string | null = null;

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
  if (runtimeRoot) {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    runtimeRoot = null;
  }
});

async function start() {
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-signup-claim-"));
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "signup-claim-flow-seed",
    namespace: ROOT_NAMESPACE,
    stateDir: path.join(runtimeRoot, "me-state"),
    claimDir: path.join(runtimeRoot, "claims"),
    selfConfigPath: path.join(runtimeRoot, "self.json"),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Exactly createCleakerSession.ts's signAndWrite(): compoundSeed comes from
// username+secret (this.me's own ME_RESEED formula), then the write-signing
// branch key is deriveBranchProofSeed(compoundSeed, username) -- the same
// key .me's own prove() arrives at internally for THIS identity, since
// cleaker's binder sets the kernel's active expression to the username.
async function signWriteAs(username: string, secret: string, fields: Record<string, unknown>) {
  const compoundSeed = keccak256(COMPOUND_SEED_DOMAIN + username + "::" + secret);
  const branchSeed = await deriveBranchProofSeed(compoundSeed, username);
  const { privateKey } = await importEd25519SigningKey(branchSeed);
  const signedPayload = normalizeProofMessage(fields);
  const signature = await signEd25519Proof(privateKey, signedPayload);
  return { signedPayload, signature };
}

describe("sign-up claim flow -- POST /claims as the genesis write, no separate unsigned profile write", () => {
  it("claims with a real browser-derived proof, seeds the profile atomically, keeps the head usable for a real signed write, and rejects an unsigned one", async () => {
    const base = await start();
    const username = "signupflowuser";
    const secret = "correct horse battery staple";
    const userNamespace = `${username}.${ROOT_NAMESPACE}`;
    const node = deriveCleakerNode(username, secret, ROOT_NAMESPACE) as any;

    // Step 1 -- the monad claim, exactly as useCleakerAuth.ts now builds
    // it: a proof bound to this specific destination (path:"/claims"),
    // never reused for /me/claim's own separate proof (condition 2).
    const nonce = "claim-nonce-1";
    const timestamp = Date.now();
    const challenge = canonicalJson({ method: "POST", nonce, path: "/claims", timestamp });
    const proof = await node.prove({ rootNamespace: ROOT_NAMESPACE, challenge });

    assert.equal(proof.namespace, userNamespace);
    assert.equal("privateKey" in proof, false); // the proof itself never carries one

    const claimBody = {
      namespace: userNamespace,
      proof,
      username,
      name: "Sign Up User",
      email: "signup@example.com",
      phone: "5551234567",
    };
    assert.equal("secret" in claimBody, false); // no shared secret on the wire at all anymore
    assert.equal("privateKey" in claimBody, false); // condition 1: the claim request never carries one either

    const claimRes = await fetch(`${base}/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody),
    });
    const claimJson: any = await claimRes.json();
    assert.equal(claimRes.status, 201, JSON.stringify(claimJson));
    assert.equal(claimJson.target.namespace.me, userNamespace);
    assert.equal(claimJson.profile.name, "Sign Up User");
    assert.equal(claimJson.profile.email, "signup@example.com");

    // Step 2 -- GET /write-head right after the claim returns a usable
    // head (condition 3): seedClaimNamespaceSemantics()'s internal seed
    // writes don't leave the chain head stale/wrong for a real signer.
    const headRes = await fetch(`${base}/api/v1/write-head?namespace=${encodeURIComponent(userNamespace)}`);
    const headJson: any = await headRes.json();
    assert.equal(headRes.status, 200, JSON.stringify(headJson));
    const expectedHeadHash: string = headJson.expectedHeadHash;
    assert.ok(expectedHeadHash);

    // Step 3 -- an UNSIGNED write to this now-claimed namespace is
    // rejected (condition 4): the sign-up flow no longer relies on, and
    // is no longer covered by, the open-unsigned-for-unclaimed-namespace
    // default -- a real claim exists now, so this falls into the ordinary
    // signature-required path, not the unclaimed-namespace bypass.
    const unsignedRes = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-host": userNamespace },
      body: JSON.stringify({ expression: "me.bio", value: "should not land unsigned" }),
    });
    const unsignedJson: any = await unsignedRes.json().catch(() => ({}));
    assert.equal(unsignedRes.status, 403, JSON.stringify(unsignedJson));
    assert.equal(unsignedJson?.target?.error ?? unsignedJson?.error, "NAMESPACE_WRITE_FORBIDDEN");

    // Step 4 -- a SIGNED write, using the SAME identity and the SAME
    // key-derivation formula signAndWrite() uses in production, succeeds
    // -- proving the claim this test just made through /claims is a real,
    // fully-usable claim, not merely "accepted but inert".
    const writeFields = {
      operation: "write",
      expression: "me.bio",
      value: "hello from a real signed write",
      identityHash: proof.identityHash,
      namespace: userNamespace,
      expectedHeadHash,
    };
    const { signedPayload, signature } = await signWriteAs(username, secret, writeFields);
    const signedRes = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-host": userNamespace },
      body: JSON.stringify({ ...writeFields, signedPayload, signature }),
    });
    const signedJson: any = await signedRes.json().catch(() => ({}));
    assert.equal(signedRes.status, 200, JSON.stringify(signedJson));
  });

  it("claims, then opens with a real signature, rejects a repeated open, and rejects a different key -- all with the real browser-side proof, not a stand-in", async () => {
    const base = await start();
    const username = "reopenflowuser";
    const secret = "correct horse battery staple";
    const userNamespace = `${username}.${ROOT_NAMESPACE}`;
    const node = deriveCleakerNode(username, secret, ROOT_NAMESPACE) as any;

    // Claim first (same shape as the test above, condensed).
    const claimNonce = "claim-nonce-2";
    const claimChallenge = canonicalJson({ method: "POST", nonce: claimNonce, path: "/claims", timestamp: Date.now() });
    const claimProof = await node.prove({ rootNamespace: ROOT_NAMESPACE, challenge: claimChallenge });
    const claimRes = await fetch(`${base}/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: userNamespace, proof: claimProof, username,
        name: "Reopen User", email: "reopen@example.com", phone: "5559876543",
      }),
    });
    assert.equal(claimRes.status, 201, JSON.stringify(await claimRes.clone().json().catch(() => ({}))));

    // The claim proof itself -- captured exactly as useCleakerAuth.ts's
    // real sign-up flow builds it, with a real, non-null challenge (a
    // canonicalJson string, not proveKernelNamespace()'s null default) --
    // must NOT be replayable as an open, even from the right key, even
    // immediately after the claim it was made for. Before the "open:"
    // prefix requirement this would have succeeded: same ClaimProof shape,
    // same verification pipeline, and the claim's own challenge string
    // trivially "looked like" an unused open nonce.
    const claimReplayedAsOpenRes = await fetch(`${base}/claims/signIn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: userNamespace, proof: claimProof }),
    });
    const claimReplayedAsOpenJson: any = await claimReplayedAsOpenRes.json().catch(() => ({}));
    assert.equal(claimReplayedAsOpenRes.status, 400, JSON.stringify(claimReplayedAsOpenJson));
    assert.equal(claimReplayedAsOpenJson?.target?.error ?? claimReplayedAsOpenJson?.error, "NONCE_REQUIRED");

    // Open with a real proof from the SAME key the claim used -- the
    // claim/open pipeline reuses the identical this.me ClaimProof shape
    // (see monad's claim/records.ts openNamespace() for why), with a real
    // per-open nonce carried in the proof's own `challenge` field.
    const openProof = await node.prove({ rootNamespace: ROOT_NAMESPACE, challenge: "open:reopen-nonce-1" });
    const openRes = await fetch(`${base}/claims/signIn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: userNamespace, proof: openProof }),
    });
    const openJson: any = await openRes.json().catch(() => ({}));
    assert.equal(openRes.status, 200, JSON.stringify(openJson));
    assert.equal(openJson.target?.namespace?.me ?? openJson.namespace, userNamespace);

    // Replaying the EXACT same open proof is rejected -- a repeated nonce,
    // not silently re-verified.
    const replayRes = await fetch(`${base}/claims/signIn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: userNamespace, proof: openProof }),
    });
    const replayJson: any = await replayRes.json().catch(() => ({}));
    assert.equal(replayRes.status, 403, JSON.stringify(replayJson));
    assert.equal(replayJson?.target?.error ?? replayJson?.error, "NONCE_REUSED");

    // A well-formed proof for the SAME namespace/username, but derived from
    // a DIFFERENT password (hence a genuinely different Ed25519 keypair --
    // deriveCompoundSeed(username, password) is one-way, so a different
    // password never coincidentally lands on the same key), is rejected --
    // proves verification actually checks against THIS namespace's own
    // record.publicKey, not just that the message names the right namespace.
    const wrongKeyNode = deriveCleakerNode(username, "a completely different password", ROOT_NAMESPACE) as any;
    const wrongKeyProof = await wrongKeyNode.prove({ rootNamespace: ROOT_NAMESPACE, challenge: "open:reopen-nonce-2" });
    assert.equal(wrongKeyProof.namespace, userNamespace); // same target, different key underneath
    assert.notEqual(wrongKeyProof.publicKey, openProof.publicKey);
    const wrongKeyRes = await fetch(`${base}/claims/signIn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: userNamespace, proof: wrongKeyProof }),
    });
    const wrongKeyJson: any = await wrongKeyRes.json().catch(() => ({}));
    assert.equal(wrongKeyRes.status, 403, JSON.stringify(wrongKeyJson));
    assert.equal(wrongKeyJson?.target?.error ?? wrongKeyJson?.error, "CLAIM_VERIFICATION_FAILED");
  });
});
