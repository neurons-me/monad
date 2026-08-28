import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "vitest";
// Deliberately NOT "this.me" -- monad's own package.json pins the published
// this.me@3.9.1, which predates these exports. GUI already depends on the
// local workspace build ("this.me": "file:../../../me/Typescript"), which
// is what real client-side signing code will actually resolve at runtime;
// this relative import reaches that same local build directly, so this
// test proves compatibility against what ships, not against the stale
// published version monad happens to be pinned to for unrelated reasons.
import {
  deriveBranchProofSeed,
  exportEd25519PublicKey,
  importEd25519SigningKey,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; the
// runtime import is what this test actually verifies.
} from "../../../me/Typescript/dist/me.es.js";
import { isNamespaceWriteAuthorized } from "../src/claim/replay";

// Proves the two independent Ed25519 implementations that must agree for a
// signed write to work end-to-end are actually compatible:
//   - this.me/crypto.ts: WebCrypto (subtle.sign("Ed25519", ...)), base64url
//     output -- the client-side signer a browser session will use.
//   - monad/claim/replay.ts: Node's native crypto.verify(), Buffer.from
//     (..., "base64") decoding -- the server-side verifier.
// Neither package's own test suite exercises the other, so this is the one
// place that would catch an encoding or format mismatch between them
// before it ships as a real client feature.

function rawEd25519PublicKeyToPem(rawPublicKeyBase64Url: string): string {
  // Mirrors claim/records.ts's own rawEd25519PublicKeyToPem() exactly --
  // same base64url-to-base64 repadding, same SPKI DER wrapping. A future
  // maintainer changing that function should feel this test complain if
  // the two drift apart.
  const padded = rawPublicKeyBase64Url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(rawPublicKeyBase64Url.length / 4) * 4, "=");
  const raw = Buffer.from(padded, "base64");
  assert.equal(raw.length, 32, "expected a 32-byte raw Ed25519 public key");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, raw]);
  return crypto
    .createPublicKey({ key: spkiDer, format: "der", type: "spki" })
    .export({ type: "spki", format: "pem" })
    .toString();
}

describe("this.me signing <-> monad verification", () => {
  it("a payload signed by this.me's branch-proof key verifies via monad's isNamespaceWriteAuthorized", async () => {
    const seedHex = crypto.randomBytes(32).toString("hex");
    const expression = "jabellae";

    const branchSeed = await deriveBranchProofSeed(seedHex, expression);
    const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
    const publicKeyPem = rawEd25519PublicKeyToPem(await exportEd25519PublicKey(publicKey));

    const bodyFields = { path: "groups.family.member.jabellae", data: "jabellae.local.cleaker" };
    // Same canonical form monad's own toStableJson() produces for this shape
    // (sorted keys, no whitespace) -- signing anything else would correctly
    // fail verification, which is exactly what the sign-A-send-B test
    // in namespaceWriteAuthorization.test.ts already covers separately.
    const canonical = `{"data":"jabellae.local.cleaker","path":"groups.family.member.jabellae"}`;
    const signature = await signEd25519Proof(privateKey, canonical);

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash: "irrelevant-for-this-check",
      claimPublicKey: publicKeyPem,
      body: { ...bodyFields, signature },
    });

    assert.equal(authorized, true);
  });

  it("rejects when the signed message doesn't match monad's own canonicalization", async () => {
    const seedHex = crypto.randomBytes(32).toString("hex");
    const branchSeed = await deriveBranchProofSeed(seedHex, "jabellae");
    const { privateKey } = await importEd25519SigningKey(branchSeed);

    // Wrong key order vs. what toStableJson() would produce -- a real
    // client bug (e.g. hand-built JSON.stringify instead of the shared
    // canonicalizer), not an attack. Should fail closed, not verify anyway.
    const wrongOrderJson = `{"path":"groups.family.member.jabellae","data":"jabellae.local.cleaker"}`;
    const signature = await signEd25519Proof(privateKey, wrongOrderJson);

    const { publicKey } = await importEd25519SigningKey(branchSeed);
    const publicKeyPem = rawEd25519PublicKeyToPem(await exportEd25519PublicKey(publicKey));

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash: "irrelevant-for-this-check",
      claimPublicKey: publicKeyPem,
      body: { path: "groups.family.member.jabellae", data: "jabellae.local.cleaker", signature },
    });

    assert.equal(authorized, false);
  });
});
