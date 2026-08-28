import type express from "express";
import {
  appendSemanticMemory,
  listHostMemoryHistory,
  listSemanticMemoriesByNamespace,
} from "../claim/memoryStore.js";
import { getClaim } from "../claim/records.js";
import { isNamespaceWriteAuthorized } from "../claim/replay.js";

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
// namespace (see groupsApi.ts: group events target the shared root
// namespace, which nobody individually owns) — what's required is that the
// caller IS a claimed identity, proven by signature, and that any field an
// event uses to assert "I did this" (created_by / member.<username>)
// actually names that same claimed identity. Anything else is impersonation.

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
    for (const key of ["identityHash", "namespace", "signature", "signedPayload"]) {
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

    const attributionError = findAttributionMismatch(rawEvents, callerNamespace);
    if (attributionError) {
      return res.status(403).json({ error: "ATTRIBUTION_MISMATCH", detail: attributionError });
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
