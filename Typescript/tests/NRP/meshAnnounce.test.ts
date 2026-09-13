/**
 * meshAnnounce.test.ts — Remote Surface Registration
 *
 * WHAT IS MESH ANNOUNCE?
 * Any monad can POST to another surface's /.mesh/announce to register itself
 * in that surface's mesh index. This is how a Raspberry Pi monad becomes
 * visible in `cleaker.me`'s directory, even though it runs on a private device.
 *
 * The announce endpoint:
 *   - Validates required fields (monad_id, namespace, endpoint)
 *   - Writes the entry to the local kernel mesh index
 *   - Throttles repeated announces from the same monad (min 10s between accepts)
 *   - Returns { ok, registered, namespace, monad_id }
 *
 * WHAT WE TEST:
 *   1. Valid announce is written to index and 200 returned
 *   2. Missing required fields → 400
 *   3. Second announce within throttle window → throttled (not re-written)
 *   4. After throttle window expires → accepted again
 *   5. claimed_namespaces defaults to [namespace] when absent
 *   6. scope_path is stored when provided
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { readMonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { createMeshAnnounceRouter, resetAnnounceThrottleForTests } from "../../src/http/meshAnnounce.js";
import { toStableJson } from "../../src/claim/replay.js";
import { claimNamespace } from "../../src/claim/records.js";
import { buildClaimProof } from "../helpers/claimProof.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;
const savedClaimDir = process.env.MONAD_CLAIM_DIR;
const savedTrustedKeysFile = process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;

let claimDir = "";

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-announce-"));
  process.env.SEED = "announce-test-seed";
  claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-announce-claims-"));
  process.env.MONAD_CLAIM_DIR = claimDir;
  delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  if (savedClaimDir === undefined) delete process.env.MONAD_CLAIM_DIR;
  else process.env.MONAD_CLAIM_DIR = savedClaimDir;
  if (savedTrustedKeysFile === undefined) delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
  else process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE = savedTrustedKeysFile;
  fs.rmSync(claimDir, { recursive: true, force: true });
  resetKernelStateForTests();
  resetAnnounceThrottleForTests();
});

// ── Signature helpers ────────────────────────────────────────────────────────

function generateSurfaceKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: publicKey as unknown as string, privateKey: privateKey as unknown as string };
}

type AnnounceFields = {
  monad_id: string;
  namespace: string;
  endpoint: string;
  claimed_namespaces: string[];
  identity_hash: string;
  timestamp: number;
};

function signAnnounceFields(privateKeyPem: string, fields: AnnounceFields): string {
  const message = toStableJson(fields);
  return crypto.sign(null, Buffer.from(message), privateKeyPem).toString("base64");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(createMeshAnnounceRouter());
  return app;
}

const VALID_IDENTITY_HASH = "a".repeat(64);

const VALID_BODY = {
  monad_id: "monad:abc123",
  identity_hash: VALID_IDENTITY_HASH,
  name: "frank",
  namespace: "suign.cleaker.me",
  endpoint: "http://raspberry.local:8161",
  claimed_namespaces: ["suign.cleaker.me"],
  tags: ["raspberry", "sensor"],
  type: "server",
  trust: "trusted-peer",
};

// ── 1. Valid announce ──────────────────────────────────────────────────────────

describe("POST /.mesh/announce — valid registration", () => {
  it("returns 200 with registered=true and writes entry to index", async () => {
    const app = makeApp();
    const res = await request(app).post("/.mesh/announce").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registered).toBe(true);
    expect(res.body.monad_id).toBe("monad:abc123");
    expect(res.body.namespace).toBe("suign.cleaker.me");

    const entry = readMonadIndexEntry("monad:abc123");
    expect(entry).not.toBeUndefined();
    expect(entry!.namespace).toBe("suign.cleaker.me");
    expect(entry!.endpoint).toBe("http://raspberry.local:8161");
    expect(entry!.name).toBe("frank");
    expect(entry!.identity_hash).toBe(VALID_IDENTITY_HASH);
  });

  it("stores tags and claimed_namespaces correctly", async () => {
    await request(makeApp()).post("/.mesh/announce").send(VALID_BODY);
    const entry = readMonadIndexEntry("monad:abc123");
    expect(entry!.tags).toEqual(["raspberry", "sensor"]);
    expect(entry!.claimed_namespaces).toContain("suign.cleaker.me");
  });
});

// ── 2. Missing required fields ────────────────────────────────────────────────

describe("POST /.mesh/announce — validation", () => {
  it("returns 400 when monad_id is missing", async () => {
    const { monad_id: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("ANNOUNCE_INVALID");
  });

  it("returns 400 when namespace is missing", async () => {
    const { namespace: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
  });

  it("returns 400 when endpoint is missing", async () => {
    const { endpoint: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
  });
});

// ── 3. Throttling ─────────────────────────────────────────────────────────────

describe("POST /.mesh/announce — throttling", () => {
  it("second immediate announce returns registered=false with reason throttled", async () => {
    const app = makeApp();
    await request(app).post("/.mesh/announce").send(VALID_BODY);
    const res2 = await request(app).post("/.mesh/announce").send(VALID_BODY);

    expect(res2.body.registered).toBe(false);
    expect(res2.body.reason).toBe("throttled");
  });

  it("different monad_id is never throttled by another monad's window", async () => {
    const app = makeApp();
    await request(app).post("/.mesh/announce").send(VALID_BODY);

    const other = { ...VALID_BODY, monad_id: "monad:xyz999", name: "ana" };
    const res = await request(app).post("/.mesh/announce").send(other);

    expect(res.body.registered).toBe(true);
  });
});

// ── 4. Defaults ───────────────────────────────────────────────────────────────

describe("POST /.mesh/announce — defaults", () => {
  it("claimed_namespaces defaults to [namespace] when absent", async () => {
    const body = { monad_id: "monad:def456", namespace: "frank.local", endpoint: "http://frank.local:8161" };
    await request(makeApp()).post("/.mesh/announce").send(body);
    const entry = readMonadIndexEntry("monad:def456");
    expect(entry!.claimed_namespaces).toEqual(["frank.local"]);
  });

  it("stores scope_path when provided", async () => {
    const body = { ...VALID_BODY, monad_id: "monad:scoped", scope_path: "/projects/music" };
    await request(makeApp()).post("/.mesh/announce").send(body);
    const entry = readMonadIndexEntry("monad:scoped");
    expect(entry!.scope_path).toBe("/projects/music");
  });
});

// ── 5. Verified vs. pending (signature verification) ──────────────────────────

describe("POST /.mesh/announce — signature verification", () => {
  it("an unsigned announce (the only kind the pre-hardening suite above sends) is stored as pending, never verified", async () => {
    await request(makeApp()).post("/.mesh/announce").send(VALID_BODY);
    const entry = readMonadIndexEntry("monad:abc123");
    expect(entry!.status).toBe("pending");
  });

  it("a validly-signed announce is marked verified", async () => {
    const { publicKey, privateKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:signed1",
      namespace: "signed.cleaker.me",
      endpoint: "http://signed.local:8161",
      claimed_namespaces: [],
      identity_hash: "",
      timestamp: Date.now(),
    };
    const signature = signAnnounceFields(privateKey, fields);

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature });

    expect(res.body.status).toBe("verified");
    expect(readMonadIndexEntry("monad:signed1")!.status).toBe("verified");
  });

  it("an announce with a garbage signature is stored as pending, not verified", async () => {
    const { publicKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:badsig1",
      namespace: "badsig.cleaker.me",
      endpoint: "http://badsig.local:8161",
      claimed_namespaces: [],
      identity_hash: "",
      timestamp: Date.now(),
    };

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature: "not-a-real-signature" });

    expect(res.body.status).toBe("pending");
    expect(readMonadIndexEntry("monad:badsig1")!.status).toBe("pending");
  });

  it("a signature whose timestamp falls outside the anti-replay window is rejected (stays pending)", async () => {
    const { publicKey, privateKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:stale1",
      namespace: "stale.cleaker.me",
      endpoint: "http://stale.local:8161",
      claimed_namespaces: [],
      identity_hash: "",
      timestamp: Date.now() - 3 * 60 * 1000, // window is 2 minutes
    };
    const signature = signAnnounceFields(privateKey, fields);

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature });

    expect(res.body.status).toBe("pending");
  });

  it("drops a claimed_namespace that a DIFFERENT identity genuinely holds a real claim for (squatting)", async () => {
    const identityHash = crypto.randomBytes(32).toString("hex");
    const victimIdentityHash = crypto.randomBytes(32).toString("hex");
    const ownedNamespace = `owned-${Date.now().toString(36)}.cleaker.me`;
    const victimNamespace = `victim-${Date.now().toString(36)}.cleaker.me`;

    const claim = await claimNamespace({
      namespace: ownedNamespace,
      secret: "s3cret",
      identityHash,
      proof: await buildClaimProof({ namespace: ownedNamespace, identityHash }),
    });
    expect(claim.ok).toBe(true);
    const victimClaim = await claimNamespace({
      namespace: victimNamespace,
      secret: "victim-secret",
      identityHash: victimIdentityHash,
      proof: await buildClaimProof({ namespace: victimNamespace, identityHash: victimIdentityHash }),
    });
    expect(victimClaim.ok).toBe(true);

    const { publicKey, privateKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:narrow1",
      namespace: "narrow.cleaker.me",
      endpoint: "http://narrow.local:8161",
      claimed_namespaces: [ownedNamespace, victimNamespace],
      identity_hash: identityHash,
      timestamp: Date.now(),
    };
    const signature = signAnnounceFields(privateKey, fields);

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature });

    expect(res.body.status).toBe("verified");
    const entry = readMonadIndexEntry("monad:narrow1");
    expect(entry!.claimed_namespaces).toEqual([ownedNamespace]);
    expect(entry!.claimed_namespaces).not.toContain(victimNamespace);
  });

  it("keeps an UNCLAIMED claimed_namespace entry — nobody holds it, so it's not squatting", async () => {
    // Corrected semantics: absence of a real .me claim is not itself
    // suspicious (the common case for a bare self-announced hostname) —
    // only a claim genuinely held by someone ELSE should be dropped.
    const identityHash = crypto.randomBytes(32).toString("hex");
    const { publicKey, privateKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:unclaimed1",
      namespace: "unclaimed-host.local",
      endpoint: "http://unclaimed-host.local:8161",
      claimed_namespaces: ["unclaimed-host.local"],
      identity_hash: identityHash,
      timestamp: Date.now(),
    };
    const signature = signAnnounceFields(privateKey, fields);

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature });

    expect(res.body.status).toBe("verified");
    expect(readMonadIndexEntry("monad:unclaimed1")!.claimed_namespaces).toEqual(["unclaimed-host.local"]);
  });

  it("rejects (403 NAMESPACE_CLAIM_CONFLICT) a verified announce whose PRIMARY namespace is genuinely claimed by a different identity", async () => {
    // The primary `namespace` field is matched directly by
    // findMonadsForNamespace() (monadIndex.ts), independently of
    // claimed_namespaces — so it needs the identical squatting check, not
    // just the array. Confirms the fix for the gap found in review: a
    // verified announcer could previously set `namespace` to someone else's
    // real claim and still become a routing candidate for it, even though
    // claimed_namespaces itself was correctly narrowed to empty.
    const victimIdentityHash = crypto.randomBytes(32).toString("hex");
    const victimNamespace = `victim-primary-${Date.now().toString(36)}.cleaker.me`;
    const victimClaim = await claimNamespace({
      namespace: victimNamespace,
      secret: "victim-secret",
      identityHash: victimIdentityHash,
      proof: await buildClaimProof({ namespace: victimNamespace, identityHash: victimIdentityHash }),
    });
    expect(victimClaim.ok).toBe(true);

    const attackerIdentityHash = crypto.randomBytes(32).toString("hex");
    const { publicKey, privateKey } = generateSurfaceKeypair();
    const fields: AnnounceFields = {
      monad_id: "monad:impersonator1",
      namespace: victimNamespace, // attacker's PRIMARY namespace, not just claimed_namespaces
      endpoint: "http://impersonator.local:8161",
      claimed_namespaces: [],
      identity_hash: attackerIdentityHash,
      timestamp: Date.now(),
    };
    const signature = signAnnounceFields(privateKey, fields);

    const res = await request(makeApp())
      .post("/.mesh/announce")
      .send({ ...fields, public_key: publicKey, signature });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("NAMESPACE_CLAIM_CONFLICT");
    // Must not have been written to the index at all under this identity.
    expect(readMonadIndexEntry("monad:impersonator1")).toBeUndefined();
  });

  it("rejects re-announcing an already-verified monad_id under a different key (first-key-wins)", async () => {
    const app = makeApp();
    const original = generateSurfaceKeypair();
    const monad_id = "monad:pinned1";
    const fields1: AnnounceFields = {
      monad_id,
      namespace: "pinned.cleaker.me",
      endpoint: "http://pinned.local:8161",
      claimed_namespaces: [],
      identity_hash: "",
      timestamp: Date.now(),
    };
    const sig1 = signAnnounceFields(original.privateKey, fields1);
    const res1 = await request(app)
      .post("/.mesh/announce")
      .send({ ...fields1, public_key: original.publicKey, signature: sig1 });
    expect(res1.body.status).toBe("verified");

    // Bypass the per-monad_id throttle (unrelated to the key-mismatch check
    // under test) so the second POST is actually evaluated.
    resetAnnounceThrottleForTests();

    const impostor = generateSurfaceKeypair();
    const fields2: AnnounceFields = { ...fields1, timestamp: Date.now() };
    const sig2 = signAnnounceFields(impostor.privateKey, fields2);
    const res2 = await request(app)
      .post("/.mesh/announce")
      .send({ ...fields2, public_key: impostor.publicKey, signature: sig2 });

    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe("MONAD_ID_KEY_MISMATCH");

    // The original verified binding must remain untouched.
    const entry = readMonadIndexEntry(monad_id);
    // parseEntry trims the stored PEM string; compare trimmed on both sides.
    expect(entry!.public_key).toBe(original.publicKey.trim());
    expect(entry!.status).toBe("verified");
    expect(entry!.endpoint).toBe("http://pinned.local:8161");
  });

  it("an UNSIGNED announce cannot downgrade an already-verified monad_id to pending (two-step first-key-wins bypass)", async () => {
    // Regression test for a real gap found in review: the original
    // first-key-wins guard only ran `if (verified && ...)`, so a later
    // announce for the same monad_id that did NOT verify at all (no
    // signature, garbage signature) skipped the guard entirely and
    // overwrote the verified entry as `status: 'pending'` with whatever
    // endpoint/public_key the attacker supplied. A SECOND attacker could
    // then re-announce the same monad_id under a genuinely different key
    // and win, since the entry's status was no longer 'verified' at that
    // point — a two-step bypass of the announced guarantee.
    const app = makeApp();
    const original = generateSurfaceKeypair();
    const monad_id = "monad:downgrade-attempt";
    const fields1: AnnounceFields = {
      monad_id,
      namespace: "downgrade.cleaker.me",
      endpoint: "http://downgrade.local:8161",
      claimed_namespaces: [],
      identity_hash: "",
      timestamp: Date.now(),
    };
    const sig1 = signAnnounceFields(original.privateKey, fields1);
    const res1 = await request(app)
      .post("/.mesh/announce")
      .send({ ...fields1, public_key: original.publicKey, signature: sig1 });
    expect(res1.body.status).toBe("verified");

    resetAnnounceThrottleForTests();

    // Step 1: an UNSIGNED announce for the same monad_id, from an attacker
    // who supplies no valid signature at all.
    const unsignedAttempt = await request(app).post("/.mesh/announce").send({
      monad_id,
      namespace: "downgrade.cleaker.me",
      endpoint: "http://attacker-controlled.example:9999",
    });
    // Must be rejected outright, not silently accepted as "pending".
    expect(unsignedAttempt.status).toBe(409);
    expect(unsignedAttempt.body.error).toBe("MONAD_ID_KEY_MISMATCH");

    // The original verified binding must be completely untouched.
    const afterUnsigned = readMonadIndexEntry(monad_id);
    expect(afterUnsigned!.status).toBe("verified");
    expect(afterUnsigned!.public_key).toBe(original.publicKey.trim());
    expect(afterUnsigned!.endpoint).toBe("http://downgrade.local:8161");

    resetAnnounceThrottleForTests();

    // Step 2: with the entry never downgraded, a genuinely different key
    // still cannot take over the monad_id either (the original guarantee).
    const impostor = generateSurfaceKeypair();
    const fields2: AnnounceFields = { ...fields1, timestamp: Date.now() };
    const sig2 = signAnnounceFields(impostor.privateKey, fields2);
    const impostorAttempt = await request(app)
      .post("/.mesh/announce")
      .send({ ...fields2, public_key: impostor.publicKey, signature: sig2 });
    expect(impostorAttempt.status).toBe(409);

    const final = readMonadIndexEntry(monad_id);
    expect(final!.status).toBe("verified");
    expect(final!.public_key).toBe(original.publicKey.trim());
    expect(final!.endpoint).toBe("http://downgrade.local:8161");
  });
});

// ── 6. Operator-configured trusted-key allowlist (opt-in pinning) ─────────────

describe("POST /.mesh/announce — MONAD_TRUSTED_ANNOUNCE_KEYS_FILE pinning", () => {
  it("a validly-signed announce from a key outside the configured allowlist stays pending", async () => {
    const trustedDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-trusted-keys-"));
    const trustedFile = path.join(trustedDir, "keys.json");
    const trusted = generateSurfaceKeypair();
    fs.writeFileSync(trustedFile, JSON.stringify({ keys: [trusted.publicKey] }));
    process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE = trustedFile;

    try {
      const untrusted = generateSurfaceKeypair();
      const untrustedFields: AnnounceFields = {
        monad_id: "monad:untrusted1",
        namespace: "untrusted.cleaker.me",
        endpoint: "http://untrusted.local:8161",
        claimed_namespaces: [],
        identity_hash: "",
        timestamp: Date.now(),
      };
      const untrustedSig = signAnnounceFields(untrusted.privateKey, untrustedFields);
      const untrustedRes = await request(makeApp())
        .post("/.mesh/announce")
        .send({ ...untrustedFields, public_key: untrusted.publicKey, signature: untrustedSig });
      expect(untrustedRes.body.status).toBe("pending");

      const trustedFields: AnnounceFields = {
        monad_id: "monad:trusted1",
        namespace: "trusted.cleaker.me",
        endpoint: "http://trusted.local:8161",
        claimed_namespaces: [],
        identity_hash: "",
        timestamp: Date.now(),
      };
      const trustedSig = signAnnounceFields(trusted.privateKey, trustedFields);
      const trustedRes = await request(makeApp())
        .post("/.mesh/announce")
        .send({ ...trustedFields, public_key: trusted.publicKey, signature: trustedSig });
      expect(trustedRes.body.status).toBe("verified");
    } finally {
      delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
      fs.rmSync(trustedDir, { recursive: true, force: true });
    }
  });

  it("fails CLOSED (trusts nothing) when the allowlist file is configured but unreadable — never falls back to 'no allowlist'", async () => {
    // Regression test for a real gap found in review: the original
    // implementation caught ANY error (missing file, malformed JSON) and
    // returned `null`, which `isAllowedAnnouncerKey` treated identically to
    // "not configured" — meaning a broken allowlist file silently trusted
    // EVERY validly-signed key, exactly when the operator believed they'd
    // locked routing down to specific pinned keys.
    process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE = path.join(
      os.tmpdir(),
      `monad-trusted-keys-missing-${Date.now().toString(36)}.json`,
    );
    try {
      const { publicKey, privateKey } = generateSurfaceKeypair();
      const fields: AnnounceFields = {
        monad_id: "monad:broken-allowlist1",
        namespace: "broken-allowlist.cleaker.me",
        endpoint: "http://broken-allowlist.local:8161",
        claimed_namespaces: [],
        identity_hash: "",
        timestamp: Date.now(),
      };
      const signature = signAnnounceFields(privateKey, fields);
      const res = await request(makeApp())
        .post("/.mesh/announce")
        .send({ ...fields, public_key: publicKey, signature });

      // Signature is genuinely valid, but the (broken) allowlist must still
      // refuse it — never silently treated as "no allowlist configured".
      expect(res.body.status).toBe("pending");
    } finally {
      delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
    }
  });

  it("fails CLOSED when the allowlist file exists but contains invalid JSON", async () => {
    const trustedDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-trusted-keys-invalid-"));
    const trustedFile = path.join(trustedDir, "keys.json");
    fs.writeFileSync(trustedFile, "{ this is not valid json");
    process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE = trustedFile;

    try {
      const { publicKey, privateKey } = generateSurfaceKeypair();
      const fields: AnnounceFields = {
        monad_id: "monad:broken-allowlist2",
        namespace: "broken-allowlist2.cleaker.me",
        endpoint: "http://broken-allowlist2.local:8161",
        claimed_namespaces: [],
        identity_hash: "",
        timestamp: Date.now(),
      };
      const signature = signAnnounceFields(privateKey, fields);
      const res = await request(makeApp())
        .post("/.mesh/announce")
        .send({ ...fields, public_key: publicKey, signature });

      expect(res.body.status).toBe("pending");
    } finally {
      delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
      fs.rmSync(trustedDir, { recursive: true, force: true });
    }
  });
});
