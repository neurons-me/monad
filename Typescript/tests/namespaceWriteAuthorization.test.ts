import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "vitest";
import { isNamespaceWriteAuthorized } from "../src/claim/replay";

// Mirrors replay.ts's own (unexported) toStableJson — sorted-key recursive
// JSON serialization. Tests need this to sign the exact string the
// authorization check will independently recompute and compare against.
function toStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toStableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${toStableJson(obj[k])}`).join(",")}}`;
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function sign(privateKey: crypto.KeyObject, message: string): string {
  return crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
}

describe("isNamespaceWriteAuthorized", () => {
  it("authorizes a real signature over the real body", () => {
    const { publicKey, privateKey } = generateKeypair();
    const claimIdentityHash = "identity-under-test";
    const bodyFields = { path: "profile.bio", data: "hello", identityHash: claimIdentityHash };
    const signature = sign(privateKey, toStableJson(bodyFields));

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash,
      claimPublicKey: publicKey,
      body: { ...bodyFields, signature },
    });

    assert.equal(authorized, true);
  });

  it("rejects a matching identityHash with no signature at all (the identityHash-echo bypass this session closed)", () => {
    const { publicKey } = generateKeypair();
    const claimIdentityHash = "identity-under-test";

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash,
      claimPublicKey: publicKey,
      body: { path: "profile.bio", data: "hello", identityHash: claimIdentityHash },
    });

    assert.equal(authorized, false);
  });

  it("rejects sign-A-send-B: a valid signature over one payload attached to a different real body", () => {
    const { publicKey, privateKey } = generateKeypair();
    const claimIdentityHash = "identity-under-test";

    // Attacker legitimately signs an innocuous payload once...
    const innocuousPayload = { path: "profile.bio", data: "harmless" };
    const signature = sign(privateKey, toStableJson(innocuousPayload));

    // ...then replays that valid signature next to a completely different
    // real body, claiming (via signedPayload) that the innocuous string is
    // what was signed for THIS request.
    const maliciousBody = {
      path: "profile.bio",
      data: "MALICIOUS OVERWRITE",
      signature,
      signedPayload: toStableJson(innocuousPayload),
    };

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash,
      claimPublicKey: publicKey,
      body: maliciousBody,
    });

    assert.equal(authorized, false, "a signature valid for one payload must not authorize a write with different real content");
  });

  it("rejects a well-formed signature from the wrong keypair", () => {
    const { privateKey: wrongPrivateKey } = generateKeypair();
    const { publicKey: realPublicKey } = generateKeypair();
    const claimIdentityHash = "identity-under-test";
    const bodyFields = { path: "profile.bio", data: "hello" };
    const signature = sign(wrongPrivateKey, toStableJson(bodyFields));

    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash,
      claimPublicKey: realPublicKey,
      body: { ...bodyFields, signature },
    });

    assert.equal(authorized, false);
  });
});
