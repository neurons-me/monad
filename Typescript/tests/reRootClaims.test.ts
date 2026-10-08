/**
 * reRootClaims.test.ts — moving a monad's root without handing its handles to strangers.
 *
 * A handle's data lives under `users.<handle>` whatever the root; the claim that authorizes writing it is per
 * namespace. After a root change every old handle is unclaimed under the new root, so the first caller to claim
 * `<handle>.<newRoot>` gets write access to the existing data. reRootNamespaceClaims re-issues the SAME claim
 * (same identityHash, same public key) under the new root first, from public material only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPersistentClaimBundle, listPersistentClaims, verifyPersistentClaim, writePersistentClaimBundle, loadPersistentClaim } from "../src/claim/manager.js";
import { getClaim, claimNamespace, reRootNamespaceClaims } from "../src/claim/records.js";

const savedClaimDir = process.env.MONAD_CLAIM_DIR;
const savedNamespace = process.env.ME_NAMESPACE;
let claimDir: string;

function userPublicPem(): string {
  return crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** A claim as the monad would have written it under `namespace`, for a user key we only hold the public half of. */
function seedClaim(namespace: string, identityHash: string, publicPem = userPublicPem(), issuedAt = 1_700_000_000_000) {
  const bundle = buildPersistentClaimBundle({ namespace, identityHash, publicKey: publicPem, issuedAt });
  writePersistentClaimBundle(bundle);
  return { publicPem, identityHash, issuedAt };
}

function sha(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

beforeEach(() => {
  claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-reroot-claims-"));
  process.env.MONAD_CLAIM_DIR = claimDir;
  // A monad moving to `localhost` runs with it as its root. The monad treats loopback hosts as aliases of the
  // configured local root, so under any other ME_NAMESPACE "localhost" would normalize to THAT root instead.
  process.env.ME_NAMESPACE = "localhost";
});

afterEach(() => {
  if (savedClaimDir === undefined) delete process.env.MONAD_CLAIM_DIR;
  else process.env.MONAD_CLAIM_DIR = savedClaimDir;
  if (savedNamespace === undefined) delete process.env.ME_NAMESPACE;
  else process.env.ME_NAMESPACE = savedNamespace;
  fs.rmSync(claimDir, { recursive: true, force: true });
});

describe("reRootNamespaceClaims", () => {
  it("re-issues a claim under the new root with the same identity, key and creation time", () => {
    const seeded = seedClaim("rr-ana.local.cleaker", "a".repeat(64));
    const oldFile = path.join(claimDir, "rr-ana.local.cleaker.json");
    const oldHash = sha(oldFile);

    const result = reRootNamespaceClaims({ from: "local.cleaker", to: "localhost" });

    expect(result.created).toEqual(["rr-ana.localhost"]);
    expect(result.skipped).toEqual([]);
    const moved = loadPersistentClaim("rr-ana.localhost")!.claim;
    expect(moved.namespace).toBe("rr-ana.localhost");
    expect(moved.identityHash).toBe(seeded.identityHash);
    expect(moved.publicKey.key).toBe(seeded.publicPem);
    expect(moved.issuedAt).toBe(seeded.issuedAt);
    expect(verifyPersistentClaim("rr-ana.localhost")).toBe(true);
    // the kernel record is what decides NAMESPACE_TAKEN
    expect(getClaim("rr-ana.localhost")).toMatchObject({ namespace: "rr-ana.localhost", identityHash: seeded.identityHash, createdAt: seeded.issuedAt });
    // non-destructive
    expect(sha(oldFile)).toBe(oldHash);
    expect(verifyPersistentClaim("rr-ana.local.cleaker")).toBe(true);
  });

  it("is idempotent: a second run changes nothing and says why", () => {
    seedClaim("rr-bo.local.cleaker", "b".repeat(64));
    reRootNamespaceClaims({ from: "local.cleaker", to: "localhost" });
    const file = path.join(claimDir, "rr-bo.localhost.json");
    const before = sha(file);
    const again = reRootNamespaceClaims({ from: "local.cleaker", to: "localhost" });
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([{ namespace: "rr-bo.local.cleaker", reason: "ALREADY_CLAIMED_UNDER_NEW_ROOT" }]);
    expect(sha(file)).toBe(before);
  });

  it("a dry run reports the plan and writes nothing", () => {
    seedClaim("rr-cy.local.cleaker", "c".repeat(64));
    const result = reRootNamespaceClaims({ from: "local.cleaker", to: "localhost", dryRun: true });
    expect(result).toMatchObject({ dryRun: true, created: ["rr-cy.localhost"] });
    expect(fs.existsSync(path.join(claimDir, "rr-cy.localhost.json"))).toBe(false);
    expect(getClaim("rr-cy.localhost")).toBeUndefined();
  });

  it("only touches the old root, and only the handles asked for", () => {
    seedClaim("rr-di.local.cleaker", "d".repeat(64));
    seedClaim("rr-ed.local.cleaker", "e".repeat(64));
    seedClaim("rr-fi.cleaker.me", "f".repeat(64));
    const result = reRootNamespaceClaims({ from: "local.cleaker", to: "localhost", handles: ["rr-di"] });
    expect(result.created).toEqual(["rr-di.localhost"]);
    expect(fs.existsSync(path.join(claimDir, "rr-ed.localhost.json"))).toBe(false);
    expect(fs.existsSync(path.join(claimDir, "rr-fi.localhost.json"))).toBe(false);
    expect(listPersistentClaims().map((entry) => entry.claim.namespace)).toContain("rr-fi.cleaker.me");
  });

  it("does not carry over a claim whose own signature is not valid", () => {
    seedClaim("rr-gu.local.cleaker", "9".repeat(64));
    const file = path.join(claimDir, "rr-gu.local.cleaker.json");
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.identityHash = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(tampered));
    const result = reRootNamespaceClaims({ from: "local.cleaker", to: "localhost" });
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([{ namespace: "rr-gu.local.cleaker", reason: "SIGNATURE_NOT_VALID" }]);
    expect(getClaim("rr-gu.localhost")).toBeUndefined();
  });

  it("refuses to run without two different roots", () => {
    expect(() => reRootNamespaceClaims({ from: "", to: "localhost" })).toThrow("REROOT_ROOTS_REQUIRED");
    expect(() => reRootNamespaceClaims({ from: "localhost", to: "localhost" })).toThrow("REROOT_ROOTS_EQUAL");
  });

  it("closes the hijack: after re-rooting, the handle is taken under the new root", async () => {
    seedClaim("rr-hu.local.cleaker", "7".repeat(64));
    reRootNamespaceClaims({ from: "local.cleaker", to: "localhost" });
    // a claim attempt for the same handle under the new root (any key) now meets NAMESPACE_TAKEN, not a free name
    const attempt = await claimNamespace({ namespace: "rr-hu.localhost", identityHash: "1".repeat(64), publicKey: userPublicPem() } as any);
    expect(attempt).toMatchObject({ ok: false });
    expect(["NAMESPACE_TAKEN", "PROOF_REQUIRED"]).toContain((attempt as { error: string }).error);
    expect(getClaim("rr-hu.localhost")?.identityHash).toBe("7".repeat(64));
  });
});
