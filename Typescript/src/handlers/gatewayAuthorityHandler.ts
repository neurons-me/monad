/**
 * gatewayAuthorityHandler.ts — thin Express surface over claim/gatewayAuthority.ts.
 * Every route just parses the body, calls the corresponding function, and
 * maps its GatewayAuthorityResult to an HTTP status. All the actual
 * signature/vigencia/authorization/replay verification lives in
 * gatewayAuthority.ts, not here — same convention as keychainHandler.ts.
 */

import type express from "express";
import {
  bootstrapGatewayAuthority,
  grantGatewayAdmin,
  readGatewayAuthority,
  revokeGatewayAdmin,
  setGatewayMainServerName,
  transferGatewayOwner,
  type GatewayAuthorityError,
} from "../claim/gatewayAuthority.js";

const ERROR_STATUS: Record<GatewayAuthorityError, number> = {
  GATEWAY_ID_REQUIRED: 400,
  NAMESPACE_REQUIRED: 400,
  CLAIM_REQUIRED: 403,
  IDENTITY_MISMATCH: 400,
  PROOF_REQUIRED: 401,
  PROOF_INVALID: 403,
  REPLAY_REJECTED: 403,
  ALREADY_BOOTSTRAPPED: 409,
  GATEWAY_NOT_BOOTSTRAPPED: 409,
  ACTING_KEY_NOT_FOUND: 404,
  ACTING_KEY_REVOKED: 403,
  PERMISSION_DENIED: 403,
  OWNER_ONLY: 403,
  TARGET_NOT_ADMIN: 400,
  CANNOT_REVOKE_OWNER: 409,
  NAMESPACE_NOT_LOCAL_TO_THIS_INSTALLATION: 403,
  MAIN_SERVER_NAME_INVALID: 400,
  MAIN_SERVER_OWNED_BY_ANOTHER_GATEWAY: 403,
  INSTALLATION_AUTHORIZATION_REQUIRED: 403,
  INSTALLATION_AUTHORIZATION_MISMATCH: 403,
  INSTALLATION_AUTHORIZATION_EXPIRED: 403,
  INSTALLATION_AUTHORIZATION_CONSUMED: 403,
  INSTALLATION_AUTHORIZATION_ALREADY_PENDING: 409,
  INSTALLATION_AUTHORIZATION_PERSIST_FAILED: 500,
};

export const getGatewayAuthorityHandler: express.RequestHandler = (req, res) => {
  const gatewayId = String(req.params.gatewayId || "").trim();
  if (!gatewayId) return res.status(400).json({ ok: false, error: "GATEWAY_ID_REQUIRED" });
  // Public, like the keychain's own key listing — owner/admins/pubkeys are
  // meant to be visible to whoever already knows this installation's id;
  // netget's own materialize step is a plain GET, no write permission
  // needed to read the confirmed state back.
  const record = readGatewayAuthority(gatewayId);
  return res.status(200).json({ ok: true, record });
};

export const bootstrapGatewayAuthorityHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = bootstrapGatewayAuthority({
    gatewayId: String(req.params.gatewayId || ""),
    namespace: String(body.namespace || ""),
    identityHash: String(body.identityHash || ""),
    keyId: String(body.keyId || ""),
    challenge: String(body.challenge || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    username: body.username ? String(body.username) : undefined,
  });
  if (!result.ok) return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  return res.status(201).json({ ok: true, record: result.value });
};

export const grantGatewayAdminHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = grantGatewayAdmin({
    gatewayId: String(req.params.gatewayId || ""),
    namespace: String(body.namespace || ""),
    actingKeyId: String(body.actingKeyId || ""),
    targetIdentityHash: String(body.targetIdentityHash || ""),
    targetNamespace: String(body.targetNamespace || ""),
    targetPublicKey: body.targetPublicKey ? String(body.targetPublicKey) : undefined,
    targetUsername: body.targetUsername ? String(body.targetUsername) : undefined,
    scopes: Array.isArray(body.scopes) ? (body.scopes as unknown[]).map(String) : [],
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  return res.status(200).json({ ok: true, record: result.value });
};

export const setGatewayMainServerNameHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = setGatewayMainServerName({
    gatewayId: String(req.params.gatewayId || ""),
    namespace: String(body.namespace || ""),
    actingKeyId: String(body.actingKeyId || ""),
    name: String(body.name || ""),
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  return res.status(200).json({ ok: true, name: result.value.name });
};

export const revokeGatewayAdminHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = revokeGatewayAdmin({
    gatewayId: String(req.params.gatewayId || ""),
    namespace: String(body.namespace || ""),
    actingKeyId: String(body.actingKeyId || ""),
    targetIdentityHash: String(req.params.identityHash || ""),
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  return res.status(200).json({ ok: true, record: result.value });
};

export const transferGatewayOwnerHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = transferGatewayOwner({
    gatewayId: String(req.params.gatewayId || ""),
    namespace: String(body.namespace || ""),
    actingKeyId: String(body.actingKeyId || ""),
    targetIdentityHash: String(body.targetIdentityHash || ""),
    nonce: String(body.nonce || ""),
    timestamp: Number(body.timestamp || 0),
    signature: String(body.signature || ""),
    signedPayload: body.signedPayload ? String(body.signedPayload) : undefined,
  });
  if (!result.ok) return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  return res.status(200).json({ ok: true, record: result.value });
};
