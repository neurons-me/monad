/**
 * commitGate.test.ts — /api/v1/commit requires a real, signed claim
 *
 * WHAT THIS PROTECTS AGAINST
 * Before this session's closure, /api/v1/commit's commitHandler accepted
 * any POST body and wrote it straight into appendSemanticMemory() with no
 * identity check at all -- anyone could write to anyone's namespace.
 * This is a hermetic, isolated version of the live end-to-end check this
 * session ran manually against the real local.cleaker monad (real claim,
 * real signature, real rejection of unsigned/impersonated/misattributed
 * writes) -- kept as a permanent regression guard, not a one-off script.
 *
 * WHY A REAL HTTP SERVER, NOT JUST CALLING THE HANDLER FUNCTION
 * The gate's correctness depends on Express's body parsing and the real
 * route wiring in src/index.ts, not just commitHandler's internals in
 * isolation -- app.listen(0) on an ephemeral port exercises the exact path
 * a real client request takes.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path (monad's
// own package.json pins the published this.me@3.9.1, which predates these
// exports); the runtime import reaches the local workspace build directly,
// same as crossPackageSigning.test.ts.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-commit-gate-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer(runtimeRoot: string) {
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-commit-gate",
    namespace: ROOT_NAMESPACE,
    stateDir: runtime.stateDir,
    claimDir: runtime.claimDir,
    selfConfigPath: runtime.selfConfigPath,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}`, claimDir: runtime.claimDir };
}

async function post(origin: string, path: string, body: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function claimTestIdentity(origin: string, username: string, secret: string) {
  const namespace = `${username}.${ROOT_NAMESPACE}`;
  const identityHash = username;
  const branchSeed = await deriveBranchProofSeed(secret, username);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");

  const timestamp = Date.now();
  const proofPayload = { identityHash, expression: username, namespace, rootNamespace: ROOT_NAMESPACE, challenge: null, timestamp };
  const proofMessage = normalizeProofMessage(proofPayload);
  const proofSignature = await signEd25519Proof(privateKey, proofMessage);

  const claimRes = await post(origin, "/", {
    operation: "claim",
    namespace,
    secret,
    identityHash,
    proof: { message: proofMessage, signature: proofSignature, publicKey: publicKeyRaw, timestamp },
  });
  if (claimRes.status !== 201) {
    throw new Error(`Test setup failed: claim returned ${claimRes.status} ${JSON.stringify(claimRes.json)}`);
  }

  async function sign(message: string): Promise<string> {
    return signEd25519Proof(privateKey, message);
  }

  return { namespace, identityHash, sign };
}

type Identity = Awaited<ReturnType<typeof claimTestIdentity>>;

async function fetchHead(origin: string, namespace: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/write-head?namespace=${encodeURIComponent(namespace)}`);
  const json = await res.json();
  return json.expectedHeadHash;
}

// Signs and posts a commit for `caller`'s own namespace, fetching the
// current chain head fresh before signing every time -- see
// syncHandler.ts's commitHandler and Surface-Identity-Claims.md §7.7.
// `overrides` lets a specific test assert something other than the caller's
// own real identityHash/namespace (e.g. impersonation attempts) while still
// getting a correctly-fetched head for the real underlying claim.
async function commit(
  origin: string,
  caller: Identity,
  events: unknown[],
  overrides: Record<string, unknown> = {},
) {
  const expectedHeadHash = await fetchHead(origin, caller.namespace);
  const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace, expectedHeadHash, ...overrides };
  const signature = await caller.sign(normalizeProofMessage(signedFields));
  return post(origin, "/api/v1/commit", { ...signedFields, signature });
}

describe("POST /api/v1/commit", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-commit-gate-cwd-"));
    const started = await startServer(runtimeRoot);
    server = started.server;
    origin = started.origin;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("accepts a real signed commit from a claimed identity", async () => {
    const caller = await claimTestIdentity(origin, "alice", "alice-secret");
    const events = [
      { namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: caller.identityHash },
      { namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Book Club" },
    ];
    const res = await commit(origin, caller, events);
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
  });

  it("rejects a commit with no proof at all", async () => {
    const caller = await claimTestIdentity(origin, "bob", "bob-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Book Club" }];

    const res = await post(origin, "/api/v1/commit", { events, identityHash: caller.identityHash, namespace: caller.namespace });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("PROOF_REQUIRED");
  });

  it("rejects a commit for a namespace nobody has claimed", async () => {
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Book Club" }];
    const res = await post(origin, "/api/v1/commit", {
      events,
      identityHash: "ghost",
      namespace: "ghost.cleaker.me",
      signature: "irrelevant-because-no-claim-exists",
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CLAIM_REQUIRED");
  });

  it("rejects a valid signature asserting a different identityHash than the claim holds", async () => {
    const caller = await claimTestIdentity(origin, "carol", "carol-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Book Club" }];
    const res = await commit(origin, caller, events, { identityHash: "not-carol" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("IDENTITY_MISMATCH");
  });

  it("rejects a real signer writing created_by as someone else's namespace", async () => {
    const caller = await claimTestIdentity(origin, "dave", "dave-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.created_by", data: "attacker.cleaker.me" }];
    const res = await commit(origin, caller, events);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("ATTRIBUTION_MISMATCH");
  });

  it("rejects a real signer writing member.<username> for a different username", async () => {
    const caller = await claimTestIdentity(origin, "erin", "erin-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.member.attacker", data: caller.namespace }];
    const res = await commit(origin, caller, events);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("ATTRIBUTION_MISMATCH");
  });

  it("rejects a stranger self-joining an already-owned group", async () => {
    const owner = await claimTestIdentity(origin, "frank", "frank-secret");
    const bootstrapRes = await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }]);
    expect(bootstrapRes.status).toBe(201);

    const stranger = await claimTestIdentity(origin, "gina", "gina-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.member.gina", data: stranger.namespace }];
    const res = await commit(origin, stranger, events);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets the owner keep writing group metadata after bootstrap", async () => {
    const owner = await claimTestIdentity(origin, "hank", "hank-secret");
    const bootstrapRes = await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }]);
    expect(bootstrapRes.status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Renamed Book Club" }];
    const res = await commit(origin, owner, events);
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
  });

  it("rejects a non-member rewriting group metadata", async () => {
    const owner = await claimTestIdentity(origin, "ivy", "ivy-secret");
    const bootstrapRes = await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }]);
    expect(bootstrapRes.status).toBe(201);

    const stranger = await claimTestIdentity(origin, "jack", "jack-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Hijacked" }];
    const res = await commit(origin, stranger, events);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets a member with an explicit scope grant write a non-reserved field", async () => {
    const owner = await claimTestIdentity(origin, "kate", "kate-secret");
    expect((await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }])).status).toBe(201);

    const member = await claimTestIdentity(origin, "leo", "leo-secret");
    expect((await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.grants.leo", data: ["notes:write"] }])).status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.notes.entry1", data: "hello" }];
    const res = await commit(origin, member, events);
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
  });

  it("rejects a member without a matching scope writing that same field", async () => {
    const owner = await claimTestIdentity(origin, "mona", "mona-secret");
    expect((await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }])).status).toBe(201);

    // "nora" is registered (has a grants entry, so isMember() is true) but was never granted notes:write.
    const member = await claimTestIdentity(origin, "nora", "nora-secret");
    expect((await commit(origin, owner, [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.grants.nora", data: [] }])).status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.notes.entry1", data: "hijacked note" }];
    const res = await commit(origin, member, events);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets only one of two concurrent bootstrap claims for the same group win", async () => {
    const first = await claimTestIdentity(origin, "oscar", "oscar-secret");
    const second = await claimTestIdentity(origin, "petra", "petra-secret");

    // first/second are two different identities' own namespaces -- their
    // chain heads are independent, so this race is entirely about
    // checkGroupAuthorization's own concurrency safety for "who becomes
    // owner of groups.concurrency-club", not about the STALE_HEAD mechanism
    // (which never sees a collision here, by construction).
    const claimAs = (caller: Identity) =>
      commit(origin, caller, [{ namespace: ROOT_NAMESPACE, path: "groups.concurrency-club.owner", data: caller.identityHash }]);

    const [resA, resB] = await Promise.all([claimAs(first), claimAs(second)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 403]);
    const rejected = resA.status === 403 ? resA : resB;
    expect(rejected.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  // The two gaps a review found in commitHandler after rootCommandHandler
  // (POST /) already had both fixes: this endpoint had the keychain.*/
  // daemon.gateways.*/routing-record guards, but neither the netget.*
  // guard nor chain-head binding (Surface-Identity-Claims.md §7.7).
  it("rejects an unsigned commit event targeting netget.delegates for a never-claimed namespace", async () => {
    const caller = await claimTestIdentity(origin, "quinn", "quinn-secret");
    const unclaimedTarget = "never-claimed.cleaker.me";
    const res = await commit(origin, caller, [
      { namespace: unclaimedTarget, path: "netget.delegates", data: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } },
    ]);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("resending the exact same signed commit fails when its event targets the caller's OWN namespace", async () => {
    const caller = await claimTestIdentity(origin, "riley", "riley-secret");
    const events = [{ namespace: caller.namespace, path: "profile.note", data: "hello" }];
    const expectedHeadHash = await fetchHead(origin, caller.namespace);
    const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace, expectedHeadHash };
    const signature = await caller.sign(normalizeProofMessage(signedFields));
    const body = { ...signedFields, signature };

    const first = await post(origin, "/api/v1/commit", body);
    expect(first.status).toBe(201);

    const replay = await post(origin, "/api/v1/commit", body);
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("STALE_HEAD");
  });

  // KNOWN, NOT-YET-CLOSED GAP -- documented here rather than silently
  // passing. expectedHeadHash is bound to callerNamespace (the identity
  // whose claim signs the commit), read fresh right before signing. When
  // an event's own `namespace` differs from callerNamespace (the shared-
  // group-root case this whole file exists to test), writing to THAT
  // namespace never moves callerNamespace's own head -- so replaying an
  // old commit whose events target a namespace other than the caller's own
  // is NOT rejected. Closing this needs per-event (or joint-namespace-set)
  // head binding, a harder design than this pass attempted; flagging it
  // explicitly rather than letting the passing test above imply more than
  // it proves.
  it("KNOWN GAP: replaying a commit whose event targets a namespace OTHER than the caller's own is not yet rejected", async () => {
    const caller = await claimTestIdentity(origin, "sana", "sana-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.replay-gap-club.owner", data: caller.identityHash }];
    const expectedHeadHash = await fetchHead(origin, caller.namespace);
    const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace, expectedHeadHash };
    const signature = await caller.sign(normalizeProofMessage(signedFields));
    const body = { ...signedFields, signature };

    const first = await post(origin, "/api/v1/commit", body);
    expect(first.status).toBe(201);

    const replay = await post(origin, "/api/v1/commit", body);
    // Documents the gap: this is 201 (accepted again), not the 409 it
    // should eventually be. If this assertion starts failing, the gap has
    // been closed -- update this test to expect 409/STALE_HEAD instead of
    // deleting it.
    expect(replay.status).toBe(201);
  });
});
