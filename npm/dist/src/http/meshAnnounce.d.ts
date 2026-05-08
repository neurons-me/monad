import express from "express";
import { type MonadIndexEntry } from "../kernel/monadIndex.js";
/** Test-only: clear the in-process throttle state. */
export declare function resetAnnounceThrottleForTests(): void;
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
export declare function createMeshAnnounceRouter(): express.Router;
/**
 * Sends a single announce POST to a remote surface.
 * Non-blocking — surface unreachable is not an error (mesh is eventually consistent).
 */
export declare function announceToSurface(surfaceUrl: string, entry: MonadIndexEntry): Promise<void>;
