import express from "express";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../kernel/monadIndex.js";

// Minimum ms between accepts from the same monad_id — prevents index flooding.
const MIN_ANNOUNCE_INTERVAL_MS = 10_000;
const lastAccepted = new Map<string, number>();

/** Test-only: clear the in-process throttle state. */
export function resetAnnounceThrottleForTests(): void {
  lastAccepted.clear();
}

function parseEntry(body: any, now: number): MonadIndexEntry | null {
  const monad_id = String(body?.monad_id || "").trim();
  const namespace = String(body?.namespace || "").trim();
  const endpoint = String(body?.endpoint || "").trim();
  if (!monad_id || !namespace || !endpoint) return null;

  return {
    monad_id,
    namespace,
    endpoint,
    name: String(body?.name || "").trim() || undefined,
    type: body?.type ?? undefined,
    trust: body?.trust ?? undefined,
    public_key: String(body?.public_key || "").trim() || undefined,
    tags: Array.isArray(body?.tags) ? (body.tags as unknown[]).map(String) : [],
    claimed_namespaces: Array.isArray(body?.claimed_namespaces)
      ? (body.claimed_namespaces as unknown[]).map(String)
      : [namespace],
    capabilities: Array.isArray(body?.capabilities) ? (body.capabilities as unknown[]).map(String) : [],
    scope_path: String(body?.scope_path || "").trim() || undefined,
    first_seen: Number(body?.first_seen) || now,
    last_seen: now,
    version: String(body?.version || "").trim() || undefined,
  };
}

/**
 * Receives monad self-registrations from remote nodes.
 *
 * Any monad that knows this surface's URL can POST here to appear in the
 * local mesh index. Staleness is handled by the existing DEFAULT_STALE_MS
 * window — entries that stop announcing go stale automatically.
 *
 * POST /.mesh/announce
 *   Body: MonadIndexEntry fields (monad_id, namespace, endpoint required)
 *   Response: { ok, registered, namespace, monad_id }
 */
export function createMeshAnnounceRouter(): express.Router {
  const router = express.Router();

  router.post("/.mesh/announce", (req, res) => {
    const now = Date.now();
    const entry = parseEntry(req.body, now);

    if (!entry) {
      return res.status(400).json({
        ok: false,
        error: "ANNOUNCE_INVALID",
        hint: "monad_id, namespace, and endpoint are required.",
      });
    }

    const prev = lastAccepted.get(entry.monad_id);
    if (prev && now - prev < MIN_ANNOUNCE_INTERVAL_MS) {
      return res.json({ ok: true, registered: false, reason: "throttled", monad_id: entry.monad_id });
    }

    lastAccepted.set(entry.monad_id, now);
    writeMonadIndexEntry(entry);

    console.log(`[mesh/announce] registered monad_id=${entry.monad_id} ns=${entry.namespace} endpoint=${entry.endpoint}`);

    return res.json({ ok: true, registered: true, namespace: entry.namespace, monad_id: entry.monad_id });
  });

  return router;
}

/**
 * Sends a single announce POST to a remote surface.
 * Non-blocking — surface unreachable is not an error (mesh is eventually consistent).
 */
export async function announceToSurface(surfaceUrl: string, entry: MonadIndexEntry): Promise<void> {
  const url = `${surfaceUrl.replace(/\/+$/, "")}/.mesh/announce`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      console.warn(`[mesh/announce] surface ${surfaceUrl} responded ${res.status}`);
    }
  } catch {
    // Surface unreachable — normal during startup, LAN transitions, offline mode.
  }
}
