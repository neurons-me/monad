/**
 * session.ts — DISABLED write/credential surface (2026-10-04 audit). See
 * the DISABLED block below for what still runs and why; this header covers
 * why the rest was turned off instead of fixed in place.
 *
 * What this router used to do: issue signed "cloud" sessions and verify
 * "host" devices, each ending in a signed token and (for host-verify) a
 * durable `host.*` record under the target username's namespace, written
 * straight through appendSemanticMemory() -- the same primitive
 * commandHandler.ts/syncHandler.ts gate heavily (reserved paths, foreign-
 * namespace checks, isNamespaceWriteAuthorized signature checks) before
 * ever reaching. This router had none of that.
 *
 * CONFIRMED LIVE, disposable monad, real HTTP, a correct Host header (an
 * earlier pass of this same check used a raw-IP Host and got an accidental
 * false negative from an unrelated foreign-namespace guard -- redone
 * properly before concluding anything):
 *   - POST /api/v1/session/cloud took `{username, capabilities}` directly
 *     from the request body -- no proof, no claim, nothing -- and returned
 *     a validly HMAC-signed token asserting attacker-chosen capabilities
 *     (tried `["admin:everything","sync","sign","local_fs"]`) for an
 *     arbitrary `username`.
 *   - POST /api/v1/session/host-verify's "attestation" verified a
 *     signature against a public key the SAME caller supplied in the same
 *     request -- proves the caller can generate a keypair, proves nothing
 *     about who they are. Confirmed: a freshly generated, attacker-owned
 *     keypair self-signing its own challenge was accepted, and a REAL,
 *     durable `host.*` record landed with `status: "authorized"` and
 *     elevated capabilities (`sync`, `sign`, `local_fs`) under an
 *     arbitrary victim username -- read back afterward to confirm it
 *     wasn't just a 200, the record genuinely persisted and listed as
 *     authorized.
 *   - POST /api/v1/hosts/revoke: same shape, no proof -- any caller could
 *     revoke any `{username, hostFingerprint}` pair.
 *
 * Why disabled rather than fixed in place: searched this entire monorepo
 * (GUI, cleaker, netget, monad, .me) for any caller of these four routes,
 * the `CleakerSession`/`*Request` types in handshake.types.ts, or the
 * attestation/token helpers below -- none exists. Confirmed separately via
 * git history that this file's real content predates keychain.ts (this
 * codebase's actual signed-identity primitive -- vigencia + autorización,
 * the same split gatewayAuthority.ts reuses) by about four months and was
 * never updated to use it. Retrofitting real auth onto a flow with no
 * demonstrated live caller would mean inventing a second, parallel
 * authentication mechanism to protect code nothing calls -- the absence of
 * an INTERNAL consumer doesn't rule out an external one this search can't
 * see, which is exactly why these routes are disabled (a clear, documented
 * rejection) rather than silently removed: a real external caller gets an
 * explicit `SESSION_HOST_FLOW_DISABLED`, not a generic 404 or a resurrected
 * vulnerability. A genuine future need for cross-device session/host
 * registration should be built on keychain.ts's existing primitives
 * (register/revoke a keychain key, vigencia checked fresh + autorización
 * checked against the account's own state), not a revived version of this.
 *
 * Left running: the two GET read endpoints below (list a username's hosts,
 * read one host's memory history). They only ever read whatever's already
 * in the kernel -- which, going forward, is nothing new, since nothing can
 * write through this file anymore -- and read access alone was never the
 * part this audit found exploitable.
 */
import express from "express";
import {
  listHostMemoryHistory,
  listHostsByNamespace,
  rebuildAuthorizedHostsProjection,
} from "../claim/memoryStore.js";
import { normalizeHttpRequestToMeTarget } from "./meTarget.js";
import { createEnvelope, createErrorEnvelope } from "./envelope.js";
import { composeProjectedNamespace } from "../namespace/identity.js";
import { resolveNamespace, resolveNamespaceProjectionRoot } from "./namespace.js";

function normalizeUsername(input: string): string {
  return String(input || "").trim().toLowerCase();
}

function resolveSessionRootNamespace(req: express.Request): string {
  const resolved = resolveNamespaceProjectionRoot(resolveNamespace(req));
  return String(resolved || "").trim().toLowerCase();
}

function resolveUserNamespace(req: express.Request, username: string): string {
  const root = resolveSessionRootNamespace(req);
  return composeProjectedNamespace(username, root);
}

// Shared response for every disabled mutating route below -- one error
// code, so a real caller (internal or, per the header above, possibly
// external) gets one documented thing to handle, not four slightly
// different shapes.
function sessionHostFlowDisabled(req: express.Request, res: express.Response): void {
  const target = normalizeHttpRequestToMeTarget(req);
  res.status(410).json(createErrorEnvelope(target, {
    error: "SESSION_HOST_FLOW_DISABLED",
    message:
      "This operation issued credentials/authorization records from caller-supplied data with no identity check. " +
      "Disabled after a live-verified audit finding (2026-10-04) found no real caller anywhere in this codebase. " +
      "See this file's header comment for what was found and why this was disabled rather than retrofitted.",
  }));
}

export function createSessionRouter(): express.Router {
  const router = express.Router();
  // Ensure read-model projection can recover after daemon/server restarts
  // -- backs the surviving GET reads below.
  rebuildAuthorizedHostsProjection();

  router.post("/api/v1/session/nonce", sessionHostFlowDisabled);
  router.post("/api/v1/session/cloud", sessionHostFlowDisabled);
  router.post("/api/v1/session/host-verify", sessionHostFlowDisabled);
  router.post("/api/v1/hosts/revoke", sessionHostFlowDisabled);

  router.get("/api/v1/hosts/:username", (req: express.Request, res: express.Response) => {
    const target = normalizeHttpRequestToMeTarget(req);
    const username = normalizeUsername(String(req.params.username || ""));
    if (!username) {
      return res.status(400).json(createErrorEnvelope(target, { error: "USERNAME_REQUIRED" }));
    }

    const namespace = resolveUserNamespace(req, username);
    const hosts = listHostsByNamespace(namespace, username).map((host: any) => ({
      id: host.id,
      namespace: host.namespace,
      host_key: host.host_key,
      username: host.username,
      fingerprint: host.fingerprint,
      public_key: host.public_key,
      hostname: host.hostname,
      label: host.label,
      local_endpoint: host.local_endpoint,
      capabilities: (() => {
        try {
          const parsed = JSON.parse(host.capabilities_json || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      status: host.status,
      created_at: host.created_at,
      last_used: host.last_used,
      revoked_at: host.revoked_at,
    }));

    return res.json(createEnvelope(target, {
      username,
      hosts,
      count: hosts.length,
    }));
  });

  router.get("/api/v1/hosts/:username/:fingerprint/history", (req: express.Request, res: express.Response) => {
    const target = normalizeHttpRequestToMeTarget(req);
    const username = normalizeUsername(String(req.params.username || ""));
    const fingerprint = String(req.params.fingerprint || "").trim();
    const limit = Number(req.query?.limit || 200);

    if (!username || !fingerprint) {
      return res.status(400).json(createErrorEnvelope(target, { error: "INVALID_HISTORY_PAYLOAD" }));
    }

    const namespace = resolveUserNamespace(req, username);
    const memories = listHostMemoryHistory(namespace, username, fingerprint, limit).map((m: any) => ({
      id: m.id,
      namespace: m.namespace,
      host_key: m.host_key,
      username: m.username,
      fingerprint: m.fingerprint,
      path: m.path,
      operator: m.operator,
      data: m.data,
      hash: m.hash,
      prevHash: m.prevHash,
      signature: m.signature,
      timestamp: m.timestamp,
    }));

    return res.json(createEnvelope(target, {
      username,
      fingerprint,
      memories,
      count: memories.length,
    }));
  });

  return router;
}
