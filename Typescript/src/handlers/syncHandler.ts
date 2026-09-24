import type express from "express";
import {
  appendSemanticMemory,
  listHostMemoryHistory,
  listSemanticMemoriesByNamespace,
} from "../claim/memoryStore.js";
import { checkGroupAuthorization } from "../claim/groupAuthorization.js";
import { checkAppAuthorization } from "../claim/appAuthorization.js";
import { getClaim } from "../claim/records.js";
import { getNamespaceChainHead, isNamespaceWriteAuthorized } from "../claim/replay.js";
import { isKeychainReservedPath } from "../claim/keychain.js";
import { isGatewayAuthorityReservedPath } from "../claim/gatewayAuthority.js";
import { isNetgetReservedPath } from "../claim/netget.js";
import { isGatewayRoutingRecordPath, isInternalRequest } from "../http/internalToken.js";
import { isForeignNamespaceCollapsingToRoot } from "../kernel/manager.js";

// This used to be a fully open write: any POST here landed in
// appendSemanticMemory() with zero identity check, regardless of who the
// caller was or which namespace the event's own `namespace` field named.
// The caller must now prove they hold a real claim — the same
// isNamespaceWriteAuthorized() signature check every other real write path
// (POST /, GatewayClaimsManager's ledger writes) already requires. See
// modules/cleaker/Typescript/typedocs/Namespace-Is-Context.md: a write is
// only real if it's attributable to a claimed .me, not a bare namespace
// string anyone could type in.
//
// The caller's own namespace need not be the same as the events' target
// namespace (group events target the shared root namespace, which nobody
// individually owns) — what's required is that the caller IS a claimed
// identity, proven by signature, and that any field an event uses to assert
// "I did this" (created_by / member.<username>) actually names that same
// claimed identity. Anything else is impersonation.
//
// Self-attribution alone doesn't gate group membership or metadata, though
// — see groupAuthorization.ts (checkGroupAuthorization) below, which
// requires the caller be an owner/admin of any groups.<key>.* namespace
// they write to, using the shared anchored-group shape defined in cleaker
// (group/group.ts) and already proven by GatewayClaimsManager.

function callerUsernameFrom(namespace: string): string {
  return String(namespace || "").trim().toLowerCase().split(".")[0] || "";
}

function findAttributionMismatch(events: unknown[], callerNamespace: string): string | null {
  const callerUsername = callerUsernameFrom(callerNamespace);
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const path = String((event as Record<string, unknown>).path || "").trim().toLowerCase();
    const data = (event as Record<string, unknown>).data;

    if (/\.created_by$/.test(path) || path === "created_by") {
      if (String(data || "").trim().toLowerCase() !== callerNamespace) {
        return `created_by must name the signer's own namespace (${path})`;
      }
      continue;
    }

    const memberMatch = path.match(/\.member\.([a-z0-9_-]+)$/);
    if (memberMatch) {
      if (memberMatch[1] !== callerUsername) {
        return `member.<username> path must be the signer's own username (${path})`;
      }
      continue;
    }
  }
  return null;
}

export const commitHandler: express.RequestHandler = async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawEvents = Array.isArray(body.events)
      ? body.events
      : body.memory && typeof body.memory === "object"
        ? [{
            namespace: body.namespace,
            ...(body.memory as Record<string, unknown>),
            data: Object.prototype.hasOwnProperty.call(body.memory as Record<string, unknown>, "data")
              ? (body.memory as Record<string, unknown>).data
              : (body.memory as Record<string, unknown>).value,
          }]
        : [];

    if (!rawEvents.length) return res.status(400).json({ error: "No events provided" });

    // Same reserved-path guard as rootCommandHandler (POST /) -- keychain.*
    // is only ever mutated through claim/keychain.ts's own validated
    // functions, never through a generic commit, even by the target
    // namespace's own claim holder.
    const reservedEvent = rawEvents.find(
      (event) => event && typeof event === "object" && isKeychainReservedPath(String((event as Record<string, unknown>).path || "")),
    );
    if (reservedEvent) {
      return res.status(403).json({ error: "KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API" });
    }
    // Same reasoning, for the gateway-authority branch (claim/gatewayAuthority.ts).
    const reservedGatewayEvent = rawEvents.find(
      (event) => event && typeof event === "object" && isGatewayAuthorityReservedPath(String((event as Record<string, unknown>).path || "")),
    );
    if (reservedGatewayEvent) {
      return res.status(403).json({ error: "GATEWAY_PATH_REQUIRES_GATEWAY_API" });
    }
    // Same reasoning as rootCommandHandler for the gateway's routing records.
    const routingEvent = rawEvents.find(
      (event) => event && typeof event === "object" && isGatewayRoutingRecordPath(String((event as Record<string, unknown>).path || "")),
    );
    if (routingEvent && !isInternalRequest(req)) {
      return res.status(403).json({ error: "GATEWAY_ROUTING_RECORDS_REQUIRE_INTERNAL_CALLER" });
    }

    // Reject before any authorization check runs, not just before the
    // write: an event whose `namespace` collapses onto kernel-ROOT storage
    // (namespaceToKernelPrefix's "" fallback) without actually BEING this
    // monad's real root must never reach checkGroupAuthorization/
    // checkAppAuthorization at all. Those gates authorize a write by
    // checking getClaim(event.namespace) -- keyed by the STRING the caller
    // chose, not by where it physically lands. Anyone can claim an
    // unrelated bare namespace string (first-claim-wins on the string
    // alone) and be its legitimate "owner" for that string while still
    // physically colliding with the real root's own apps.*/groups.* data.
    // Proven exploitable end-to-end in
    // namespaceCollisionAuthorization.test.ts before this guard existed.
    const foreignRootEvent = rawEvents.find(
      (event) => event && typeof event === "object" && isForeignNamespaceCollapsingToRoot(String((event as Record<string, unknown>).namespace || "")),
    );
    if (foreignRootEvent) {
      return res.status(403).json({ error: "FOREIGN_NAMESPACE_REJECTED", detail: "This namespace does not resolve to the monad's real root or a sub-identity of it -- it cannot be used as a write target here." });
    }

    // Same reasoning as rootCommandHandler's own netget.* guard
    // (Surface-Identity-Claims.md §7.1/§7.7): an unclaimed namespace has no
    // claim to check a signature against, so without this, a commit event
    // could write netget.delegates (or any other netget.* path) for any
    // never-claimed namespace completely unsigned -- meshAnnounce.ts would
    // read it as a real delegation. Checked per-EVENT against that event's
    // own `namespace` field, not just the caller's claimed namespace: a
    // commit is explicitly allowed to target a namespace other than the
    // caller's own (the shared-root group case this file's header comment
    // describes), so the netget guard has to follow the same per-event
    // namespace, not assume it matches callerNamespace below.
    const unclaimedNetgetEvent = rawEvents.find((event) => {
      if (!event || typeof event !== "object") return false;
      const record = event as Record<string, unknown>;
      if (!isNetgetReservedPath(String(record.path || ""))) return false;
      return !getClaim(String(record.namespace || "").trim().toLowerCase());
    });
    if (unclaimedNetgetEvent) {
      return res.status(403).json({ error: "NETGET_PATH_REQUIRES_CLAIM" });
    }

    const callerIdentityHash = String(body.identityHash || "").trim();
    const callerNamespace = String(body.namespace || "").trim().toLowerCase();
    if (!callerIdentityHash || !callerNamespace || !String(body.signature || "").trim()) {
      return res.status(401).json({ error: "PROOF_REQUIRED" });
    }

    const claim = getClaim(callerNamespace);
    if (!claim) {
      return res.status(403).json({ error: "CLAIM_REQUIRED" });
    }
    if (claim.identityHash !== callerIdentityHash) {
      return res.status(403).json({ error: "IDENTITY_MISMATCH" });
    }

    const signedFields: Record<string, unknown> = { events: rawEvents };
    for (const key of ["identityHash", "namespace", "signature", "signedPayload", "expectedHeadHash"]) {
      if (body[key] !== undefined) signedFields[key] = body[key];
    }
    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash: claim.identityHash,
      claimPublicKey: claim.publicKey,
      body: signedFields,
    });
    if (!authorized) {
      return res.status(403).json({ error: "PROOF_INVALID" });
    }

    // isNamespaceWriteAuthorized() above only proves "the claim holder
    // signed exactly this body" -- same gap rootCommandHandler had before
    // Surface-Identity-Claims.md §7.7's fix: nothing bound WHEN. A
    // previously-valid signed commit could otherwise be replayed at any
    // later time (e.g. a stale signed grant silently un-revoking a
    // delegate). `namespace` is already effectively bound here (it's a
    // required field, always part of signedFields above, unlike
    // rootCommandHandler's namespace-from-Host-header gap) -- only the
    // temporal binding was missing. No fallback for a body missing
    // expectedHeadHash, for the same reason rootCommandHandler has none.
    const expectedHeadHash = getNamespaceChainHead(callerNamespace, claim);
    const bodyExpectedHeadHash = String(body.expectedHeadHash || "").trim();
    if (bodyExpectedHeadHash !== expectedHeadHash) {
      return res.status(409).json({
        error: "STALE_HEAD",
        detail: "This namespace's state has changed since the commit was signed (or the signed body never named the current head). Re-read the current head and re-sign.",
        expectedHeadHash,
      });
    }

    const attributionError = findAttributionMismatch(rawEvents, callerNamespace);
    if (attributionError) {
      return res.status(403).json({ error: "ATTRIBUTION_MISMATCH", detail: attributionError });
    }

    const groupError = checkGroupAuthorization(rawEvents, callerIdentityHash);
    if (groupError) {
      return res.status(403).json({ error: "GROUP_AUTHORIZATION_REQUIRED", detail: groupError });
    }

    const appError = checkAppAuthorization(rawEvents, callerIdentityHash);
    if (appError) {
      return res.status(403).json({ error: "APP_AUTHORIZATION_REQUIRED", detail: appError });
    }

    const results = [];
    for (const event of rawEvents) {
      // Each event's own `namespace` field is its write target (e.g. the
      // shared root namespace groups live under) -- a completely different
      // thing from body.namespace above (the CALLER's claimed identity).
      // Events are passed through exactly as sent; nothing to strip here.
      try {
        const memory = appendSemanticMemory(event);
        results.push({ ok: true, memory });
      } catch (err) {
        results.push({ ok: false, error: String(err) });
      }
    }

    const first = results[0] && (results[0] as { ok: boolean; memory?: { hash?: string } });
    return res.status(201).json({
      ok: results.every((entry) => Boolean((entry as { ok?: boolean }).ok)),
      hash: first?.memory?.hash || null,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};

// Lets a client find out "is this identity the namespace's claimed owner"
// without a dedicated per-app claim step -- see appAuthorization.ts: a
// namespace owner has implicit authority over every apps.<appId>.* branch
// inside it, so the UI needs this to decide whether to show edit tools
// *before* the caller attempts a write, not just react to a 403 afterward.
// Deliberately returns only a boolean, never the claim record itself
// (publicKey, secretCommitment, etc.) -- identityHash is already a public
// fingerprint (shown in the UI, meant to be shared), so confirming a
// namespace/identityHash pair leaks nothing that wasn't already public.
export const namespaceOwnerHandler: express.RequestHandler = async (req, res) => {
  try {
    const namespace = String(req.query.namespace || "").trim().toLowerCase();
    const identityHash = String(req.query.identityHash || "").trim();
    if (!namespace || !identityHash) {
      return res.status(400).json({ error: "namespace and identityHash are required" });
    }
    const claim = getClaim(namespace);
    return res.json({
      claimed: Boolean(claim),
      isOwner: Boolean(claim && claim.identityHash === identityHash),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};

export const syncEventsHandler: express.RequestHandler = async (req, res) => {
  try {
    const namespace = String(req.query.namespace || "").trim().toLowerCase();
    const since = Number(req.query.since || 0);
    if (!namespace) return res.status(400).json({ error: "Missing namespace" });
    const username = String(req.query.username || "");
    const fingerprint = String(req.query.fingerprint || "");
    const limit = Number(req.query.limit || 2000);
    const events = (username && fingerprint
      ? listHostMemoryHistory(namespace, username, fingerprint, limit)
      : listSemanticMemoriesByNamespace(namespace, { limit })
    ).filter((e: { timestamp?: number }) => Number(e?.timestamp ?? 0) > since);
    return res.json({ events, memories: events });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
