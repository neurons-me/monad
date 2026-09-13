import crypto from "crypto";
import fs from "fs";
import express from "express";
import { normalizeMeIdentityHash } from "../identity/meIdentity.js";
import { getClaim } from "../claim/records.js";
import { decodeSignature, toStableJson, verifySignature } from "../claim/replay.js";
import { readMonadIndexEntry, writeMonadIndexEntry, type MonadIndexEntry } from "../kernel/monadIndex.js";

// Minimum ms between accepts from the same monad_id — prevents index flooding.
const MIN_ANNOUNCE_INTERVAL_MS = 10_000;
// Anti-replay window for a SIGNED announce's own timestamp — separate from
// (and much tighter than) meshSelect.ts's DEFAULT_STALE_MS liveness window:
// this bounds how old a signature can be and still be accepted at all, not
// how long a verified entry stays selectable afterward.
const SIGNATURE_WINDOW_MS = 2 * 60 * 1000;

const lastAccepted = new Map<string, number>();

/** Test-only: clear the in-process throttle state. */
export function resetAnnounceThrottleForTests(): void {
  lastAccepted.clear();
}

/**
 * Optional operator-configured key pin, layered on top of (never instead of)
 * the general signature check above — NOT a global PKI. For the first real
 * Mac↔VM link, an operator can point `MONAD_TRUSTED_ANNOUNCE_KEYS_FILE` at a
 * JSON file (`{"keys": ["-----BEGIN PUBLIC KEY-----...", ...]}`) listing the
 * exact public keys of the nodes they actually control. Unset (the default),
 * any announce whose signature verifies is trusted, same as before this
 * pinning existed — this only ever narrows an already-verified announce
 * further, never widens who counts as verified.
 *
 * Distinguishes "not configured" from "configured but unreadable/invalid":
 * a set env var pointing at a missing file or garbage JSON is an operator
 * mistake, not an absence of policy — treating it as "no allowlist" would
 * silently fail OPEN (any signed key trusted) exactly when the operator
 * believed they'd locked it down. Fails closed instead: an empty set trusts
 * nothing until the file is fixed.
 */
type TrustedKeysResult = { configured: false } | { configured: true; keys: Set<string> };

function loadTrustedAnnounceKeys(): TrustedKeysResult {
  const path = process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
  if (!path) return { configured: false };
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    const keys = Array.isArray(raw) ? raw : Array.isArray(raw?.keys) ? raw.keys : [];
    return { configured: true, keys: new Set(keys.map((k: unknown) => String(k).trim()).filter(Boolean)) };
  } catch {
    // Configured but unreadable/malformed — fail closed (empty set), never
    // fall through to "no allowlist configured".
    return { configured: true, keys: new Set() };
  }
}

function isAllowedAnnouncerKey(publicKey: string): boolean {
  const trusted = loadTrustedAnnounceKeys();
  if (!trusted.configured) return true;
  return trusted.keys.has(publicKey.trim());
}

/**
 * The exact fields a signature must cover — endpoint, namespaces, timestamp,
 * AND the claimed identity, so a valid signature can't be replayed against a
 * different endpoint/namespace set or timestamp, can't be re-served under a
 * different `monad_id`, and — critically — can't have its `identity_hash`
 * swapped for someone else's AFTER signing (identity_hash itself is public,
 * non-secret information; binding it into the signed payload at least
 * prevents a valid signature being paired with a different identity claim
 * than the one it was made for). This does NOT by itself prove the signing
 * key is authorized to speak for that identity_hash — that deeper binding
 * (which surface key may act for which `.me` identity) is the pre-existing,
 * documented gap in CLAUDE.md's "Known architectural gaps" #1
 * (surface identity is unclaimed). Closing that requires a real delegation
 * mechanism, out of scope here — this only closes the narrower "tamper with
 * the identity_hash field of an otherwise-valid signed message" case.
 */
function canonicalAnnounceMessage(fields: {
  monad_id: string;
  namespace: string;
  endpoint: string;
  claimed_namespaces: string[];
  identity_hash: string;
  timestamp: number;
}): string {
  return toStableJson(fields);
}

function parseEntry(body: any, now: number): (MonadIndexEntry & { _timestamp?: number; _signature?: string }) | null {
  const monad_id = String(body?.monad_id || "").trim();
  const namespace = String(body?.namespace || "").trim();
  const endpoint = String(body?.endpoint || "").trim();
  if (!monad_id || !namespace || !endpoint) return null;

  const claimed_namespaces = Array.isArray(body?.claimed_namespaces)
    ? (body.claimed_namespaces as unknown[]).map(String)
    : [namespace];

  return {
    monad_id,
    identity_hash: normalizeMeIdentityHash(body?.identity_hash),
    namespace,
    endpoint,
    name: String(body?.name || "").trim() || undefined,
    type: body?.type ?? undefined,
    trust: body?.trust ?? undefined,
    public_key: String(body?.public_key || "").trim() || undefined,
    tags: Array.isArray(body?.tags) ? (body.tags as unknown[]).map(String) : [],
    claimed_namespaces,
    capabilities: Array.isArray(body?.capabilities) ? (body.capabilities as unknown[]).map(String) : [],
    scope_path: String(body?.scope_path || "").trim() || undefined,
    first_seen: Number(body?.first_seen) || now,
    last_seen: now,
    version: String(body?.version || "").trim() || undefined,
    status: "pending",
    _timestamp: Number(body?.timestamp) || undefined,
    _signature: String(body?.signature || "").trim() || undefined,
  };
}

/**
 * Verifies a signed announce, returning the identity that genuinely signed
 * it (never trusted from the body directly — a signature only proves
 * possession of `public_key`'s private half, and `verifySignature` confirms
 * that cryptographically). Returns `null` for anything that doesn't verify
 * — missing signature, missing/garbage public_key, stale timestamp, or a
 * signature that doesn't match the canonical fields. Never throws.
 */
function verifyAnnounceSignature(
  entry: MonadIndexEntry & { _timestamp?: number; _signature?: string },
  now: number,
): boolean {
  if (!entry.public_key || !entry._signature || !entry._timestamp) return false;
  if (Math.abs(now - entry._timestamp) > SIGNATURE_WINDOW_MS) return false;

  const signature = decodeSignature(entry._signature);
  if (!signature) return false;

  const message = canonicalAnnounceMessage({
    monad_id: entry.monad_id,
    namespace: entry.namespace,
    endpoint: entry.endpoint,
    claimed_namespaces: entry.claimed_namespaces ?? [],
    identity_hash: entry.identity_hash ?? "",
    timestamp: entry._timestamp,
  });

  return verifySignature(entry.public_key, message, signature);
}

/**
 * Whether `identityHash` may treat `ns` as its own for routing purposes.
 *
 * An UNCLAIMED namespace (nobody holds a real `.me` claim for it — the
 * common case for a bare machine hostname like `disposable-node-a.local`
 * that was never formally claimed) passes through: there is no one to
 * squat on, and requiring a claim here would make every ordinary
 * self-hostname announce unroutable. A CLAIMED namespace only passes when
 * the announcing identity IS the claim holder — otherwise this is exactly
 * the squatting case: an announcer using someone else's already-claimed
 * namespace as its own `namespace`/`claimed_namespaces` value. `getClaim()`
 * is the same local authority check `isNamespaceWriteAuthorized`'s
 * namespace-write path relies on elsewhere; reused here, not re-derived.
 */
function isNamespaceUsableByIdentity(ns: string, identityHash: string | undefined): boolean {
  const claim = getClaim(ns);
  if (!claim) return true;
  return !!identityHash && claim.identityHash === identityHash;
}

/**
 * Drops any `claimed_namespaces` entry the announcing identity doesn't
 * actually hold a real `.me` claim for (when that namespace IS claimed by
 * someone). Signing your own announcement only proves you sent it — it says
 * nothing about which namespaces you're AUTHORIZED to serve. A namespace
 * failing this check is dropped from the authoritative set, not silently
 * trusted — it's still visible in the raw announce (nothing here mutates
 * what was logged), just excluded from what routing is allowed to treat as
 * this monad's own.
 */
function authorizedClaimedNamespaces(claimedNamespaces: string[], identityHash: string | undefined): string[] {
  return claimedNamespaces.filter((ns) => isNamespaceUsableByIdentity(ns, identityHash));
}

/**
 * Receives monad self-registrations from remote nodes.
 *
 * Any monad that knows this surface's URL can POST here — that alone only
 * ever produces a `status: 'pending'` entry, never eligible for mesh
 * selection (see meshSelect.ts's candidate filter). An entry only becomes
 * `status: 'verified'` when the announce carries a real Ed25519 signature
 * (over monad_id+namespace+endpoint+claimed_namespaces+timestamp) matching
 * the supplied `public_key`, within a short anti-replay window, AND the
 * same `monad_id` was never previously verified under a DIFFERENT key
 * (first-key-wins — a later announce claiming to be the same monad but
 * signed by a different key is rejected, not silently swapped in; this
 * check runs for ANY later announce, verified or not — an unsigned one is
 * rejected too, not allowed to downgrade the entry to `pending` and reopen
 * the slot for a different key). Both `claimed_namespaces` and the primary
 * `namespace` field of a verified entry are narrowed/checked against
 * whoever actually holds a real `.me` claim for them — verification proves
 * "I sent this," never "I may serve this namespace." An unclaimed namespace
 * (nobody holds a `.me` claim for it — the common case for a bare hostname)
 * passes through unchanged. Staleness is handled by the existing
 * DEFAULT_STALE_MS window — entries that stop announcing go stale
 * automatically.
 *
 * POST /.mesh/announce
 *   Body: MonadIndexEntry fields (monad_id, namespace, endpoint required)
 *         + optional signature, timestamp (required together for `verified`)
 *   Response: { ok, registered, namespace, monad_id, status }
 */
export function createMeshAnnounceRouter(): express.Router {
  const router = express.Router();

  router.post("/.mesh/announce", (req, res) => {
    const now = Date.now();
    const parsed = parseEntry(req.body, now);

    if (!parsed) {
      return res.status(400).json({
        ok: false,
        error: "ANNOUNCE_INVALID",
        hint: "monad_id, namespace, and endpoint are required.",
      });
    }

    const prev = lastAccepted.get(parsed.monad_id);
    if (prev && now - prev < MIN_ANNOUNCE_INTERVAL_MS) {
      return res.json({ ok: true, registered: false, reason: "throttled", monad_id: parsed.monad_id });
    }

    const verified =
      verifyAnnounceSignature(parsed, now) && isAllowedAnnouncerKey(parsed.public_key || "");

    // First-key-wins: once a monad_id is verified under a key, NO later
    // announce for that same monad_id may overwrite its index entry unless
    // it verifies under that SAME key — regardless of whether the later
    // announce itself verifies. This check must run whenever an existing
    // entry is already verified, not only when the incoming one also is:
    // an earlier version gated this check on `verified` alone, so an
    // unsigned/garbage-signature announce for an already-verified monad_id
    // skipped the check entirely and silently overwrote the entry as
    // `pending` — after which a genuinely different key could re-announce
    // and win, since the entry was no longer `status: 'verified'`. That
    // defeated the whole guarantee via a trivial two-step attack (found in
    // review, confirmed by a repro in meshAnnounce.test.ts before this fix).
    const existing = readMonadIndexEntry(parsed.monad_id);
    if (
      existing?.status === "verified" &&
      existing.public_key &&
      (!verified || existing.public_key !== parsed.public_key)
    ) {
      return res.status(409).json({
        ok: false,
        error: "MONAD_ID_KEY_MISMATCH",
        hint: "This monad_id is already verified under a different key.",
      });
    }

    const { _timestamp, _signature, ...entry } = parsed;
    entry.status = verified ? "verified" : "pending";
    if (verified) {
      entry.claimed_namespaces = authorizedClaimedNamespaces(entry.claimed_namespaces ?? [], entry.identity_hash);

      // The PRIMARY `namespace` field is just as much a routing-eligibility
      // claim as `claimed_namespaces` — findMonadsForNamespace() matches on
      // it directly (monadIndex.ts) — so it needs the identical squatting
      // check, not just the array. Without this, a verified announcer could
      // set `namespace` to someone else's genuinely-claimed namespace and
      // become a routing candidate for it even though claimed_namespaces
      // itself gets correctly narrowed to empty (found in review, confirmed
      // by a repro before this fix). Reject outright rather than silently
      // drop, since `namespace` is a required field with nothing safe to
      // fall back to.
      if (!isNamespaceUsableByIdentity(entry.namespace, entry.identity_hash)) {
        return res.status(403).json({
          ok: false,
          error: "NAMESPACE_CLAIM_CONFLICT",
          hint: "The announced namespace is already claimed by a different identity.",
        });
      }
    }

    lastAccepted.set(entry.monad_id, now);
    writeMonadIndexEntry(entry);

    console.log(
      `[mesh/announce] ${entry.status} monad_id=${entry.monad_id} ns=${entry.namespace} endpoint=${entry.endpoint}`,
    );

    return res.json({ ok: true, registered: true, namespace: entry.namespace, monad_id: entry.monad_id, status: entry.status });
  });

  return router;
}

/** Signs an announce payload with this surface's own persistent Ed25519 key
 *  (PKCS8 PEM, from selfMapping.ts's ensureCleakerIdentityConfig()) — the
 *  same key already published as this entry's own `public_key`. Returns
 *  null (never throws) if signing fails for any reason, e.g. no private
 *  key configured; callers fall back to sending an unsigned (pending-only)
 *  announce rather than blocking on it. */
function signAnnounce(privateKeyPem: string, message: string): string | null {
  try {
    const signature = crypto.sign(null, Buffer.from(message), privateKeyPem);
    return signature.toString("base64");
  } catch {
    return null;
  }
}

/**
 * Sends a single announce POST to a remote surface. Signs it with
 * `privateKeyPem` when provided (this surface's own persistent key) so the
 * receiving surface can mark the entry `verified` instead of `pending` —
 * omit it only for a deliberately-unsigned/local-only announce.
 * Non-blocking — surface unreachable is not an error (mesh is eventually
 * consistent).
 */
export async function announceToSurface(surfaceUrl: string, entry: MonadIndexEntry, privateKeyPem?: string): Promise<void> {
  const url = `${surfaceUrl.replace(/\/+$/, "")}/.mesh/announce`;
  const timestamp = Date.now();
  const claimed_namespaces = entry.claimed_namespaces ?? [];
  let signature: string | null = null;
  if (privateKeyPem && entry.public_key) {
    const message = canonicalAnnounceMessage({
      monad_id: entry.monad_id,
      namespace: entry.namespace,
      endpoint: entry.endpoint,
      claimed_namespaces,
      identity_hash: entry.identity_hash ?? "",
      timestamp,
    });
    signature = signAnnounce(privateKeyPem, message);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...entry, timestamp, ...(signature ? { signature } : {}) }),
    });
    if (!res.ok) {
      console.warn(`[mesh/announce] surface ${surfaceUrl} responded ${res.status}`);
    }
  } catch {
    // Surface unreachable — normal during startup, LAN transitions, offline mode.
  }
}
