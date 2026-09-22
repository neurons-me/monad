/**
 * nodeGrantsHandler.ts — thin Express surface over claim/nodeGrants.ts's `verifyExecutorAction`. This is
 * the first real caller-facing surface for node grants (design doc §8's next step, after the in-process
 * walkthrough): an executor reads one node of an identity's tree over HTTP, using its own signing key, not
 * the identity's. All the actual grant/expiry/revocation/prefix/signature checking lives in
 * claim/nodeGrants.ts, not here -- same division of responsibility keychainHandler.ts already uses over
 * claim/keychain.ts.
 *
 * Deliberately narrow: only `operation: 'read'` is wired to an actual effect (returning the node's current
 * value). Granting and revoking a node grant are NOT exposed over HTTP here -- design doc §7/§8 sequence
 * this HTTP surface strictly after the in-process mechanism is proven, and strictly before any write
 * effect or the gateway guard; expanding this to write operations or to grant/revoke-over-HTTP is a
 * separate, later step, not assumed by this file.
 */
import type express from "express";
import { verifyExecutorAction, type ExecutorActionError } from "../claim/nodeGrants.js";
import { readSemanticValueForNamespace } from "../claim/memoryStore.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";

const ERROR_STATUS: Record<ExecutorActionError, number> = {
  NAMESPACE_REQUIRED: 400,
  NODE_PATH_REQUIRED: 400,
  OPERATIONS_REQUIRED: 400,
  EXECUTOR_KEY_REQUIRED: 400,
  GRANTING_KEY_NOT_FOUND: 404,
  GRANTING_KEY_REVOKED: 403,
  CLAIM_REQUIRED: 403,
  PROOF_REQUIRED: 401,
  PROOF_INVALID: 403,
  REPLAY_REJECTED: 409,
  GRANT_NOT_FOUND: 404,
  ALREADY_REVOKED: 409,
  NOT_GRANTED: 403,
};

/** POST /api/v1/node-grants/read -- the executor proves it holds a live grant covering this exact read,
 *  target included, before anything is returned. `operation` is fixed to 'read' here, never taken from the
 *  request body: this handler performs exactly one effect, and a caller cannot widen that by claiming a
 *  different operation string while this code path still only ever reads. */
export const nodeGrantReadHandler: express.RequestHandler = (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawNamespace = String(body.namespace || "").trim();
  const namespace = normalizeNamespaceIdentity(rawNamespace);
  if (!namespace) {
    return res.status(ERROR_STATUS.NAMESPACE_REQUIRED).json({ ok: false, error: "NAMESPACE_REQUIRED" });
  }

  const target = String(body.target || "").trim();
  if (!target) {
    return res.status(ERROR_STATUS.NODE_PATH_REQUIRED).json({ ok: false, error: "NODE_PATH_REQUIRED" });
  }

  const result = verifyExecutorAction(namespace, {
    grantId: String(body.grantId || "").trim(),
    operation: "read",
    target,
    params: body.params ?? null,
    nonce: String(body.nonce || "").trim(),
    timestamp: Number(body.timestamp),
    signature: String(body.signature || "").trim(),
    signedPayload: body.signedPayload !== undefined ? String(body.signedPayload) : undefined,
  });

  if (!result.ok) {
    return res.status(ERROR_STATUS[result.error]).json({ ok: false, error: result.error });
  }

  // Authorization confirmed fresh, against the live record, immediately before this read -- a grant
  // revoked a moment ago already failed the check above; nothing here caches an earlier verdict.
  const value = readSemanticValueForNamespace(namespace, target);
  return res.status(200).json({ ok: true, target, value });
};
