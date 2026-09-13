/**
 * keychainHandler.ts — thin Express surface over claim/keychain.ts. Every
 * route just parses the body, calls the corresponding keychain.ts function,
 * and maps its KeychainResult to an HTTP status. All the actual signature/
 * permission/vigencia/replay verification lives in keychain.ts, not here.
 */

import type express from "express";
import {
  getKeychainKey,
  listKeychainKeys,
  recoverKeychainWithRoot,
  registerKeychainKey,
  revokeKeychainKey,
  signKeychainOperation,
  type KeychainError,
} from "../claim/keychain.js";
import { getClaim } from "../claim/records.js";

const ERROR_STATUS: Record<KeychainError, number> = {
  NAMESPACE_REQUIRED: 400,
  INVALID_PUBLIC_KEY: 400,
  CLAIM_REQUIRED: 403,
  IDENTITY_MISMATCH: 403,
  PROOF_REQUIRED: 401,
  PROOF_INVALID: 403,
  REPLAY_REJECTED: 403,
  ACTING_KEY_REQUIRED: 400,
  ACTING_KEY_NOT_FOUND: 404,
  ACTING_KEY_REVOKED: 403,
  PERMISSION_DENIED: 403,
  TARGET_KEY_NOT_FOUND: 404,
  CANNOT_REVOKE_LAST_ADMIN: 409,
  RESERVED_PATH: 403,
  FOREIGN_NAMESPACE_REJECTED: 403,
};

// Structured detail for error codes whose bare name doesn't explain itself
// -- same wording commandHandler.ts/syncHandler.ts already return for this
// exact rejection on their own write paths, so a client sees one consistent
// explanation regardless of which write surface produced it.
const ERROR_DETAIL: Partial<Record<KeychainError, string>> = {
  FOREIGN_NAMESPACE_REJECTED:
    "This request's namespace does not resolve to the monad's real root or a sub-identity of it -- it cannot be used as a write target here.",
};

function keychainErrorResponse(res: express.Response, error: KeychainError) {
  const body: Record<string, unknown> = { ok: false, error };
  const detail = ERROR_DETAIL[error];
  if (detail) body.detail = detail;
  return res.status(ERROR_STATUS[error]).json(body);
}

export const listKeychainKeysHandler: express.RequestHandler = (req, res) => {
  const namespace = String(req.query.namespace || "").trim();
  if (!namespace) return res.status(400).json({ ok: false, error: "NAMESPACE_REQUIRED" });
  // Public keys, permissions, and authorization status are all meant to be
  // visible -- listing the keychain never requires proof, same as any
  // public-key registry.
  const keys = listKeychainKeys(namespace);
  return res.status(200).json({ ok: true, keys });
};

export const getKeychainKeyHandler: express.RequestHandler = (req, res) => {
  const namespace = String(req.query.namespace || "").trim();
  const keyId = String(req.params.keyId || "").trim();
  if (!namespace) return res.status(400).json({ ok: false, error: "NAMESPACE_REQUIRED" });
  const key = getKeychainKey(namespace, keyId);
  if (!key) return res.status(404).json({ ok: false, error: "TARGET_KEY_NOT_FOUND" });
  // A key's mere existence under `namespace`'s keychain proves it's active
  // for THAT branch, but says nothing on its own about which identityHash
  // that branch belongs to (namespace and identityHash are independent —
  // the claim record is what binds them). Any caller that needs to verify
  // "this key really does belong to the identity it claims to" (e.g.
  // netget's gateway-claim commit) needs that binding too, so it's
  // returned alongside the key rather than requiring a second endpoint.
  const claim = getClaim(namespace);
  return res.status(200).json({ ok: true, key, claimIdentityHash: claim?.identityHash ?? null });
};

export const registerKeychainKeyHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = registerKeychainKey({
    namespace: String(body.namespace || ""),
    identityHash: body.identityHash ? String(body.identityHash) : undefined,
    newKey: (body.newKey || {}) as { publicKey: string; label: string; admin?: boolean },
    actingKeyId: body.actingKeyId ? String(body.actingKeyId) : undefined,
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return keychainErrorResponse(res, result.error);
  return res.status(201).json({ ok: true, key: result.value });
};

export const revokeKeychainKeyHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = revokeKeychainKey({
    namespace: String(body.namespace || ""),
    actingKeyId: String(body.actingKeyId || ""),
    targetKeyId: String(req.params.keyId || ""),
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return keychainErrorResponse(res, result.error);
  return res.status(200).json({ ok: true, key: result.value });
};

export const recoverKeychainHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = recoverKeychainWithRoot({
    namespace: String(body.namespace || ""),
    identityHash: String(body.identityHash || ""),
    newKey: (body.newKey || {}) as { publicKey: string; label: string },
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return keychainErrorResponse(res, result.error);
  return res.status(201).json({ ok: true, key: result.value });
};

export const signKeychainOperationHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = signKeychainOperation({
    namespace: String(body.namespace || ""),
    keyId: String(req.params.keyId || ""),
    payload: body.payload,
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return keychainErrorResponse(res, result.error);
  return res.status(200).json({ ok: true, opId: result.value.opId });
};
