import express from "express";
import crypto from "crypto";
import { claimNamespace, openNamespace } from "../claim/records.js";
import { getMemoriesForNamespace } from "../claim/replay.js";
import { appendSemanticMemory, readSemanticValueForNamespace } from "../claim/memoryStore.js";
import { seedClaimNamespaceSemantics } from "../claim/claimSemantics.js";
import { normalizeHttpRequestToMeTarget } from "./meTarget.js";
import { createEnvelope, createErrorEnvelope } from "./envelope.js";
import { parseNamespaceIdentityParts } from "../namespace/identity.js";

function toStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => toStableJson(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${toStableJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

function computeProofId(input: Record<string, unknown>) {
  return crypto
    .createHash("sha256")
    .update(toStableJson(input))
    .digest("hex");
}

function parseNamespaceIdentity(namespace: string) {
  return parseNamespaceIdentityParts(namespace);
}

export function readOpenedClaimProfile(namespace: string) {
  const identity = parseNamespaceIdentity(namespace);
  const username = normalizeUsername(
    readSemanticValueForNamespace(namespace, "profile.username") || identity.username || "",
  );
  const name = normalizeName(readSemanticValueForNamespace(namespace, "profile.name"));
  const email = normalizeEmail(readSemanticValueForNamespace(namespace, "profile.email"));
  const phone = normalizePhone(readSemanticValueForNamespace(namespace, "profile.phone"));
  const claimedAt = Number(readSemanticValueForNamespace(namespace, "auth.claimed_at") || 0);

  return {
    profile: {
      username,
      name,
      email,
      phone,
    },
    claimedAt: Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : null,
  };
}

function getDefaultReadPolicy(namespace: string) {
  const identity = parseNamespaceIdentity(namespace);
  const allowed = ["profile/*", "me/public/*", `${namespace}/*`];
  if (identity.host) {
    allowed.push(`${identity.host}/*`);
  }
  return {
    allowed,
    capabilities: ["read"],
  };
}

function normalizeEmail(input: unknown): string {
  return String(input || "").trim().toLowerCase();
}

function normalizePhone(input: unknown): string {
  return String(input || "").trim();
}

function normalizeName(input: unknown): string {
  return String(input || "").trim().replace(/\s+/g, " ");
}

function normalizeUsername(input: unknown): string {
  return String(input || "").trim().toLowerCase();
}

function validateClaimProfile(body: Record<string, unknown>, namespace: string) {
  const identity = parseNamespaceIdentity(namespace);
  const username = normalizeUsername(body.username);
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);

  if (!username) return { ok: false as const, error: "USERNAME_REQUIRED" };
  if (!name) return { ok: false as const, error: "NAME_REQUIRED" };
  if (!email) return { ok: false as const, error: "EMAIL_REQUIRED" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false as const, error: "EMAIL_INVALID" };
  if (!phone) return { ok: false as const, error: "PHONE_REQUIRED" };
  if (phone.replace(/\D/g, "").length < 8) return { ok: false as const, error: "PHONE_INVALID" };
  if (identity.username && username !== identity.username) {
    return { ok: false as const, error: "USERNAME_NAMESPACE_MISMATCH" };
  }

  return {
    ok: true as const,
    username,
    name,
    email,
    phone,
  };
}

export const claimRequestHandler: express.RequestHandler = async (req, res) => {
  const target = normalizeHttpRequestToMeTarget(req);
  const body = req.body ?? {};
  const namespace = String(body.namespace || "");
  const profile = validateClaimProfile(body as Record<string, unknown>, namespace);
  if (!profile.ok) {
    return res.status(400).json(createErrorEnvelope(target, { error: profile.error }));
  }

  const out = await claimNamespace({
    namespace,
    secret: String(body.secret || ""),
    identityHash: String(body.identityHash || "").trim(),
    publicKey: String(body.publicKey || "").trim() || null,
    privateKey: String(body.privateKey || "").trim() || null,
    proof: (body.proof && typeof body.proof === "object") ? body.proof : null,
  });

  if (!out.ok) {
    const status =
      out.error === "NAMESPACE_TAKEN"
        ? 409
        : out.error === "NAMESPACE_REQUIRED"
            || out.error === "SECRET_REQUIRED"
            || out.error === "IDENTITY_HASH_REQUIRED"
            || out.error === "CLAIM_KEY_INVALID"
            || out.error === "CLAIM_KEYPAIR_MISMATCH"
            || out.error === "PROOF_MESSAGE_INVALID"
            || out.error === "PROOF_NAMESPACE_MISMATCH"
            || out.error === "PROOF_TIMESTAMP_INVALID"
          ? 400
          : out.error === "PROOF_INVALID"
            ? 403
          : 500;
    return res.status(status).json(createErrorEnvelope(target, { error: out.error }));
  }

  const timestamp = Date.now();
  seedClaimNamespaceSemantics({
    namespace: out.record.namespace,
    username: profile.username,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    passwordHash: out.record.identityHash,
    timestamp,
  });

  return res.status(201).json(createEnvelope(target, {
    namespace: out.record.namespace,
    identityHash: out.record.identityHash,
    publicKey: out.record.publicKey,
    createdAt: out.record.createdAt,
    profile: {
      username: profile.username,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
    },
    persistentClaim: out.persistentClaim,
  }));
};

export const openRequestHandler: express.RequestHandler = (req, res) => {
  const target = normalizeHttpRequestToMeTarget(req);
  const body = req.body ?? {};
  const out = openNamespace({
    namespace: String(body.namespace || ""),
    secret: String(body.secret || ""),
    identityHash: String(body.identityHash || "").trim(),
  });

  if (!out.ok) {
    const status =
      out.error === "CLAIM_NOT_FOUND"
        ? 404
        : out.error === "CLAIM_VERIFICATION_FAILED" || out.error === "IDENTITY_MISMATCH"
          ? 403
        : out.error === "NAMESPACE_REQUIRED"
            || out.error === "SECRET_REQUIRED"
            || out.error === "IDENTITY_HASH_REQUIRED"
          ? 400
          : 500;
    return res.status(status).json(createErrorEnvelope(target, { error: out.error }));
  }

  const memories = getMemoriesForNamespace(out.record.namespace);
  const openedAt = Date.now();
  appendSemanticMemory({
    namespace: out.record.namespace,
    path: "session.opened_at",
    operator: "=",
    data: openedAt,
    timestamp: openedAt,
  });
  const policy = getDefaultReadPolicy(out.record.namespace);
  const identity = parseNamespaceIdentity(out.record.namespace);
  const openedClaim = readOpenedClaimProfile(out.record.namespace);
  const audit = {
    proofId: computeProofId({
      namespace: out.record.namespace,
      identityHash: out.record.identityHash,
      noise: out.noise,
      memories,
    }),
    openedAt,
  };

  return res.json(createEnvelope(target, {
    verified: true,
    reasonCode: null,
    reason: null,
    identity,
    policy,
    audit,
    namespace: out.record.namespace,
    identityHash: out.record.identityHash,
    createdAt: openedClaim.claimedAt || out.record.createdAt,
    profile: openedClaim.profile,
    noise: out.noise,
    memories,
    openedAt,
  }));
};

export function createClaimsRouter(): express.Router {
  const router = express.Router();
  router.post("/claims", claimRequestHandler);
  router.post("/claims/signIn", openRequestHandler);
  router.post("/claims/open", openRequestHandler);
  return router;
}
