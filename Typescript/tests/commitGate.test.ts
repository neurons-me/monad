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
    const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace };
    const signature = await caller.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
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
    const signedFields = { events, identityHash: "not-carol", namespace: caller.namespace };
    const signature = await caller.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("IDENTITY_MISMATCH");
  });

  it("rejects a real signer writing created_by as someone else's namespace", async () => {
    const caller = await claimTestIdentity(origin, "dave", "dave-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.created_by", data: "attacker.cleaker.me" }];
    const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace };
    const signature = await caller.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("ATTRIBUTION_MISMATCH");
  });

  it("rejects a real signer writing member.<username> for a different username", async () => {
    const caller = await claimTestIdentity(origin, "erin", "erin-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.member.attacker", data: caller.namespace }];
    const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace };
    const signature = await caller.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("ATTRIBUTION_MISMATCH");
  });

  it("rejects a stranger self-joining an already-owned group", async () => {
    const owner = await claimTestIdentity(origin, "frank", "frank-secret");
    const bootstrap = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }], identityHash: owner.identityHash, namespace: owner.namespace };
    const bootstrapRes = await post(origin, "/api/v1/commit", { ...bootstrap, signature: await owner.sign(normalizeProofMessage(bootstrap)) });
    expect(bootstrapRes.status).toBe(201);

    const stranger = await claimTestIdentity(origin, "gina", "gina-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.member.gina", data: stranger.namespace }];
    const signedFields = { events, identityHash: stranger.identityHash, namespace: stranger.namespace };
    const signature = await stranger.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets the owner keep writing group metadata after bootstrap", async () => {
    const owner = await claimTestIdentity(origin, "hank", "hank-secret");
    const bootstrap = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }], identityHash: owner.identityHash, namespace: owner.namespace };
    const bootstrapRes = await post(origin, "/api/v1/commit", { ...bootstrap, signature: await owner.sign(normalizeProofMessage(bootstrap)) });
    expect(bootstrapRes.status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Renamed Book Club" }];
    const signedFields = { events, identityHash: owner.identityHash, namespace: owner.namespace };
    const signature = await owner.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
  });

  it("rejects a non-member rewriting group metadata", async () => {
    const owner = await claimTestIdentity(origin, "ivy", "ivy-secret");
    const bootstrap = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }], identityHash: owner.identityHash, namespace: owner.namespace };
    const bootstrapRes = await post(origin, "/api/v1/commit", { ...bootstrap, signature: await owner.sign(normalizeProofMessage(bootstrap)) });
    expect(bootstrapRes.status).toBe(201);

    const stranger = await claimTestIdentity(origin, "jack", "jack-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.name", data: "Hijacked" }];
    const signedFields = { events, identityHash: stranger.identityHash, namespace: stranger.namespace };
    const signature = await stranger.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets a member with an explicit scope grant write a non-reserved field", async () => {
    const owner = await claimTestIdentity(origin, "kate", "kate-secret");
    const bootstrap = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }], identityHash: owner.identityHash, namespace: owner.namespace };
    expect((await post(origin, "/api/v1/commit", { ...bootstrap, signature: await owner.sign(normalizeProofMessage(bootstrap)) })).status).toBe(201);

    const member = await claimTestIdentity(origin, "leo", "leo-secret");
    const grant = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.grants.leo", data: ["notes:write"] }], identityHash: owner.identityHash, namespace: owner.namespace };
    expect((await post(origin, "/api/v1/commit", { ...grant, signature: await owner.sign(normalizeProofMessage(grant)) })).status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.notes.entry1", data: "hello" }];
    const signedFields = { events, identityHash: member.identityHash, namespace: member.namespace };
    const signature = await member.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
  });

  it("rejects a member without a matching scope writing that same field", async () => {
    const owner = await claimTestIdentity(origin, "mona", "mona-secret");
    const bootstrap = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.owner", data: owner.identityHash }], identityHash: owner.identityHash, namespace: owner.namespace };
    expect((await post(origin, "/api/v1/commit", { ...bootstrap, signature: await owner.sign(normalizeProofMessage(bootstrap)) })).status).toBe(201);

    // "nora" is registered (has a grants entry, so isMember() is true) but was never granted notes:write.
    const member = await claimTestIdentity(origin, "nora", "nora-secret");
    const register = { events: [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.grants.nora", data: [] }], identityHash: owner.identityHash, namespace: owner.namespace };
    expect((await post(origin, "/api/v1/commit", { ...register, signature: await owner.sign(normalizeProofMessage(register)) })).status).toBe(201);

    const events = [{ namespace: ROOT_NAMESPACE, path: "groups.book-club.notes.entry1", data: "hijacked note" }];
    const signedFields = { events, identityHash: member.identityHash, namespace: member.namespace };
    const signature = await member.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });

  it("lets only one of two concurrent bootstrap claims for the same group win", async () => {
    const first = await claimTestIdentity(origin, "oscar", "oscar-secret");
    const second = await claimTestIdentity(origin, "petra", "petra-secret");

    const claimAs = async (caller: { identityHash: string; namespace: string; sign: (m: string) => Promise<string> }) => {
      const signedFields = {
        events: [{ namespace: ROOT_NAMESPACE, path: "groups.concurrency-club.owner", data: caller.identityHash }],
        identityHash: caller.identityHash,
        namespace: caller.namespace,
      };
      const signature = await caller.sign(normalizeProofMessage(signedFields));
      return post(origin, "/api/v1/commit", { ...signedFields, signature });
    };

    const [resA, resB] = await Promise.all([claimAs(first), claimAs(second)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 403]);
    const rejected = resA.status === 403 ? resA : resB;
    expect(rejected.json.error).toBe("GROUP_AUTHORIZATION_REQUIRED");
  });
});
