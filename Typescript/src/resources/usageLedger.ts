/**
 * @module ResourceUsageLedger
 * @memberof module:monad.resources
 *
 * Materialises in-memory surface telemetry into signed semantic ledger entries.
 *
 * ## Why this bridge exists
 *
 * `surfaceTelemetry.ts` collects per-request events and system metrics in RAM
 * only — data is lost on restart and cannot be audited or aggregated across
 * sessions.  This module writes the same data into the kernel-backed semantic
 * ledger so it becomes part of the content-addressed memory chain.  NetGet
 * and downstream accounting consumers (the "resource crypto") can then read
 * signed, time-ordered entries without touching monad's HTTP layer.
 *
 * ## Recording levels (see telemetryPolicy.ts for why)
 *
 *   **Requests are counted, not written one by one.**  Subscribed via
 *   `addSurfaceRequestListener`; each request only updates an in-memory
 *   aggregate (by identity, host, operation, status).  No request appends a
 *   memory of its own -- automatic probes and pollers used to be most of the
 *   chain.  Older chains may still hold per-request entries at
 *   `surface.usage.requests` ({@link RequestLedgerEntry}); nothing new is
 *   written there.
 *
 *   **Window aggregate** (`surface.usage.window`) -- ONE signed memory per
 *   window (default 10 min, never under 1 min).  Payload: windowStartedAt,
 *   windowEndedAt, requestRate, cpuRatio, memoryRatio, pressureCpu, and
 *   `requests` -- the window's counts (total, anonymous, per identity, by
 *   host, by operation), each map capped at TELEMETRY_MAX_KEYS keys.
 *
 *   **File export** (`$NETGET_DATA_DIR/runtime/gateway-usage.json`) -- the
 *   same aggregate, for netget's GatewayUsageAggregator and Lua.
 *
 * ## Entry signatures
 *
 * Every entry embeds a `sig` object:
 *   - `alg`    — `"ed25519"`
 *   - `value`  — base64 Ed25519 signature over the canonical (sorted-key) JSON
 *                of the payload fields (everything except `sig` itself)
 *   - `pubKey` — hex SPKI public key for independent verification
 *
 * The signing key is derived deterministically from the monad SEED via
 * HKDF-SHA-256 (`info = "resource-signing-key-v1"`).  This ensures entries
 * from the same monad instance are always signed by the same key, making
 * historical audit possible.  When no SEED is present (e.g. pure unit tests)
 * a fresh ephemeral Ed25519 keypair is generated.
 *
 * ## Integration
 *
 * ```typescript
 * // In your monad bootstrap sequence (after ensureRootSemanticBootstrap):
 * import { defaultUsageLedger } from './resources/usageLedger.js';
 * defaultUsageLedger.start();
 * ```
 *
 * @see {@link module:monad.http.surfaceTelemetry}
 * @see {@link module:monad.claim.memoryStore}
 */

import crypto from 'crypto';
import fs     from 'fs';
import os     from 'os';
import path   from 'path';

import { appendSemanticMemory }          from '../claim/memoryStore.js';
import {
    TELEMETRY_DEFAULT_INTERVAL_MS,
    TELEMETRY_MAX_KEYS,
    TELEMETRY_OVERFLOW_KEY,
    resolveTelemetryIntervalMs,
} from './telemetryPolicy.js';
import { getRootNamespace }              from '../kernel/manager.js';
import {
    addSurfaceRequestListener,
    getSurfaceTelemetrySnapshot,
    type SurfaceRequestEvent,
} from '../http/surfaceTelemetry.js';

// ---------------------------------------------------------------------------
// Deterministic signing-key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a stable Ed25519 private key from the monad SEED via HKDF-SHA-256.
 *
 * The PKCS #8 DER wrapper for Ed25519 is the fixed 16-byte prefix defined in
 * RFC 8410, followed by the 32-byte raw private key seed produced by HKDF.
 *
 * Falls back to an ephemeral randomly-generated keypair when no SEED is set
 * (e.g. during isolated unit tests that do not load the kernel).
 */
function resolveSigningKey(): crypto.KeyObject {
    const seed = (process.env.SEED ?? process.env.ME_SEED ?? '').trim();
    if (seed) {
        try {
            // 32 bytes of deterministic key material from the daemon SEED.
            const material = Buffer.from(
                crypto.hkdfSync('sha256', seed, 'monad-usage-ledger', 'resource-signing-key-v1', 32),
            );
            // PKCS #8 v1 wrapper for Ed25519 (RFC 8410 §10.3):
            //   30 2e                 — SEQUENCE, length 46
            //     02 01 00            — INTEGER 0 (version)
            //     30 05               — SEQUENCE, length 5
            //       06 03 2b 65 70    — OID 1.3.101.112 (id-EdDSA / Ed25519)
            //     04 22               — OCTET STRING, length 34
            //       04 20             — OCTET STRING, length 32
            //       <32 bytes>        — private key seed
            const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
            return crypto.createPrivateKey({
                key:    Buffer.concat([pkcs8Header, material]),
                format: 'der',
                type:   'pkcs8',
            });
        } catch {
            // Fall through — HKDF or key import failed (unusual), use ephemeral key.
        }
    }
    return crypto.generateKeyPairSync('ed25519').privateKey;
}

// ---------------------------------------------------------------------------
// Local measurement helpers
// ---------------------------------------------------------------------------

/** Resident set size divided by total physical memory (0–1). */
function computeMemoryRatio(): number {
    const total = os.totalmem();
    if (total <= 0) return 0;
    const rss = process.memoryUsage().rss;
    return Math.min(1, rss / total);
}

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

/**
 * Produces deterministic JSON where all object keys are recursively sorted.
 * Used as the signing input so that `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }`
 * produce identical byte sequences (and thus identical signatures).
 *
 * @internal — exported for test-suite verification only.
 */
export function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${(value as unknown[]).map(stableJson).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Gateway usage snapshot — written to $NETGET_DATA_DIR/runtime/gateway-usage.json
// ---------------------------------------------------------------------------

/**
 * Per-identity (or anonymous) usage bucket for one window.
 * Keyed by `identityHash` in `GatewayUsageSnapshot.identities`; the null-identity
 * bucket is stored in `GatewayUsageSnapshot.anonymous`.
 */
export interface IdentityUsageBucket {
    requests:        number;
    totalDurationMs: number;
    avgDurationMs:   number;
    /** HTTP status code → request count.  Keys are stringified numbers ("200", "404", …). */
    statusCodes:     Record<string, number>;
    /** Operation label → request count (`"read"`, `"write"`, …). */
    operations:      Record<string, number>;
    /** Host name → request count. */
    hosts:           Record<string, number>;
}

/**
 * Rolling window aggregate written to `gateway-usage.json`.
 *
 * nginx Lua can read this file (same hot-reload pattern as `domain-map.json`) to
 * make policy decisions: rate-limiting, quota enforcement, billing hooks, etc.
 * The companion `gateway-usage.version` file triggers an in-memory reload without
 * a worker restart.
 */
export interface GatewayUsageSnapshot {
    /** Normalised gateway identifier (hostname, lowercased). */
    gatewayId:       string;
    windowStartedAt: number;
    windowEndedAt:   number;
    totalRequests:   number;
    /** Requests attributed to a known `identityHash`. */
    identities:      Record<string, IdentityUsageBucket>;
    /** Requests with no `identityHash` (unauthenticated or pre-auth). */
    anonymous:       IdentityUsageBucket;
    /** Host → total request count for the window. */
    byHost:          Record<string, number>;
    /** Operation label → total request count for the window. */
    byOperation:     Record<string, number>;
    /** System metrics sampled at window end. */
    system: {
        cpuRatio:    number;
        memoryRatio: number;
        pressureCpu: number;
    };
    /** SHA-256 of canonical JSON payload (32 hex chars) — change-detection signal. */
    version:   string;
    updatedAt: number;
}

// ---------------------------------------------------------------------------
// Internal rolling-aggregate helpers
// ---------------------------------------------------------------------------

interface RollingBucket {
    requests:        number;
    totalDurationMs: number;
    statusCodes:     Record<string, number>;
    operations:      Record<string, number>;
    hosts:           Record<string, number>;
}

function freshBucket(): RollingBucket {
    return { requests: 0, totalDurationMs: 0, statusCodes: {}, operations: {}, hosts: {} };
}

interface RollingAggregate {
    byIdentity: Map<string | null, RollingBucket>;
    byHost:     Map<string, number>;
    byOperation: Map<string, number>;
    total:      number;
}

function freshAggregate(): RollingAggregate {
    return { byIdentity: new Map(), byHost: new Map(), byOperation: new Map(), total: 0 };
}

/** `map[key] += 1`, but a map that already holds TELEMETRY_MAX_KEYS keys counts new keys under the overflow key. */
function countCapped(map: Record<string, number>, key: string): void {
    const k = key in map || Object.keys(map).length < TELEMETRY_MAX_KEYS ? key : TELEMETRY_OVERFLOW_KEY;
    map[k] = (map[k] ?? 0) + 1;
}

function countCappedMap(map: Map<string, number>, key: string): void {
    const k = map.has(key) || map.size < TELEMETRY_MAX_KEYS ? key : TELEMETRY_OVERFLOW_KEY;
    map.set(k, (map.get(k) ?? 0) + 1);
}

function bucketToPublic(b: RollingBucket): IdentityUsageBucket {
    return {
        requests:        b.requests,
        totalDurationMs: b.totalDurationMs,
        avgDurationMs:   b.requests > 0 ? Math.round(b.totalDurationMs / b.requests) : 0,
        statusCodes:     { ...b.statusCodes },
        operations:      { ...b.operations },
        hosts:           { ...b.hosts },
    };
}

function normalizeHostname(h: string): string {
    return h.trim().toLowerCase().replace(/\s+/g, '-');
}

function computeSnapshotVersion(
    snap: Omit<GatewayUsageSnapshot, 'version' | 'updatedAt'>,
): string {
    return crypto.createHash('sha256')
        .update(stableJson(snap), 'utf8')
        .digest('hex')
        .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Signature envelope embedded in every ledger entry. */
export interface LedgerEntrySig {
    /** Always `"ed25519"`. */
    alg:    'ed25519';
    /**
     * Base64-encoded Ed25519 signature over the canonical (sorted-key) JSON of
     * the payload — i.e. the full entry object **without** the `sig` field.
     */
    value:  string;
    /**
     * Hex-encoded DER SPKI public key.
     * Use `crypto.createPublicKey({ key: Buffer.from(pubKey, 'hex'), format: 'der', type: 'spki' })`
     * to import for verification.
     */
    pubKey: string;
}

/**
 * Shape of the per-request entries older monads wrote at `surface.usage.requests`.  Nothing writes it any more
 * (telemetryPolicy.ts); kept to read existing chains.
 */
export interface RequestLedgerEntry {
    /** Identity hash of the authenticated caller, or `null` when unauthenticated. */
    identityHash: string | null;
    /** Monad namespace derived from the request host / routing table. */
    namespace:    string;
    method:       string;
    url:          string;
    status:       number;
    durationMs:   number;
    host:         string;
    operation:    string;
    requestedAt:  number;
    /** CPU load ratio (0–1) sampled at event time. */
    cpuRatio:     number;
    /** RSS / total memory ratio (0–1) sampled at event time. */
    memoryRatio:  number;
    sig: LedgerEntrySig;
}

/** The requests of one window, counted (`WindowLedgerEntry.requests`). Maps are capped at TELEMETRY_MAX_KEYS keys. */
export interface WindowRequestCounts {
    total:       number;
    anonymous:   IdentityUsageBucket;
    identities:  Record<string, IdentityUsageBucket>;
    byHost:      Record<string, number>;
    byOperation: Record<string, number>;
}

/** One signed aggregate entry per window (`surface.usage.window`). */
export interface WindowLedgerEntry {
    windowStartedAt: number;
    windowEndedAt:   number;
    /** Number of requests received in the last 10 s reported by surfaceTelemetry (instantaneous rate). */
    requestRate:     number;
    cpuRatio:        number;
    memoryRatio:     number;
    pressureCpu:     number;
    /** Every request of the window, counted. Absent on entries written before this field existed. */
    requests?:       WindowRequestCounts;
    sig: LedgerEntrySig;
}

// ---------------------------------------------------------------------------
// ResourceUsageLedger
// ---------------------------------------------------------------------------

/**
 * Bridges surface telemetry into the semantic ledger.
 *
 * Create one instance per monad daemon and call {@link start} during bootstrap.
 * No recording happens until `start()` is called, so the module is safe to
 * import before the kernel is initialised.
 *
 * @example
 * ```typescript
 * import { defaultUsageLedger } from './resources/usageLedger.js';
 *
 * // After ensureRootSemanticBootstrap() and kernel hydration:
 * defaultUsageLedger.start();
 *
 * // On graceful shutdown:
 * defaultUsageLedger.stop();
 * ```
 */
export class ResourceUsageLedger {
    private readonly _privateKey:   crypto.KeyObject;
    private readonly _publicKeyHex: string;

    /** Resolved lazily on first write to avoid triggering kernel init at import time. */
    private _namespace: string | null = null;

    private _pending:          SurfaceRequestEvent[] = [];
    private _drainScheduled:   boolean = false;
    private _windowStart:      number  = 0;
    private _windowTimer:      ReturnType<typeof setInterval> | null = null;
    private _unsubscribe:      (() => void) | null = null;

    /** Rolling aggregate for the current window — reset after each file export. */
    private _agg: RollingAggregate = freshAggregate();

    constructor() {
        this._privateKey   = resolveSigningKey();
        this._publicKeyHex = crypto
            .createPublicKey(this._privateKey)
            .export({ type: 'spki', format: 'der' })
            .toString('hex');
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Starts the ledger bridge.
     *
     * Subscribes to surface request events and arms the window snapshot timer.
     * Subsequent calls while already running are silently ignored.
     *
     * @param windowMs - Window interval in milliseconds.  Default: 10 minutes; never below 1 minute
     *   (resolveTelemetryIntervalMs).
     * @returns `this` for chaining.
     */
    start(windowMs: number = TELEMETRY_DEFAULT_INTERVAL_MS): this {
        if (this._unsubscribe) return this;   // already running

        this._windowStart = Date.now();
        this._unsubscribe = addSurfaceRequestListener(e => this._enqueue(e));

        const interval = resolveTelemetryIntervalMs(windowMs);
        this._windowTimer = setInterval(() => this.flushWindowSnapshot(), interval);
        // Unref so the timer does not prevent clean process exit.
        this._windowTimer.unref?.();

        return this;
    }

    /**
     * Stops the ledger bridge and synchronously drains any buffered events.
     *
     * After `stop()` the instance can be restarted with {@link start}.
     */
    stop(): void {
        this._unsubscribe?.();
        this._unsubscribe = null;

        if (this._windowTimer) {
            clearInterval(this._windowTimer);
            this._windowTimer = null;
        }

        // Count buffered events before teardown (they belong to the current window).
        this._drainNow();
    }

    /** `true` when the bridge is actively recording. */
    get isRunning(): boolean {
        return this._unsubscribe !== null;
    }

    /**
     * Hex-encoded DER SPKI public key.
     *
     * All entries signed by this instance carry the same `sig.pubKey` value
     * and can be independently verified with this key.
     */
    get publicKeyHex(): string {
        return this._publicKeyHex;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private _resolveNamespace(): string {
        if (!this._namespace) {
            try { this._namespace = getRootNamespace(); } catch { this._namespace = 'unknown'; }
        }
        return this._namespace;
    }

    /**
     * Signs `payload` using the instance's private key.
     * The input is serialised with {@link stableJson} (recursively sorted keys)
     * so the signature is stable regardless of property insertion order.
     */
    private _sign(payload: Record<string, unknown>): LedgerEntrySig {
        const data  = Buffer.from(stableJson(payload), 'utf8');
        const value = crypto.sign(null, data, this._privateKey).toString('base64');
        return { alg: 'ed25519', value, pubKey: this._publicKeyHex };
    }

    private _enqueue(event: SurfaceRequestEvent): void {
        this._pending.push(event);
        if (!this._drainScheduled) {
            this._drainScheduled = true;
            // Drain on the next I/O cycle — never blocks the request response.
            setImmediate(() => this._drainNow());
        }
    }

    private _drainNow(): void {
        this._drainScheduled = false;
        const events = this._pending.splice(0);
        for (const event of events) {
            this._accumulate(event);
        }
    }

    /**
     * Counts one request into the window aggregate.  Writes nothing to the chain: the window entry carries the counts
     * (telemetryPolicy.ts).  Identities beyond TELEMETRY_MAX_KEYS share the anonymous bucket's overflow accounting.
     */
    private _accumulate(event: SurfaceRequestEvent): void {
        let key: string | null = event.identityHash ?? null;
        if (key !== null && !this._agg.byIdentity.has(key)) {
            const named = this._agg.byIdentity.size - (this._agg.byIdentity.has(null) ? 1 : 0);
            if (named >= TELEMETRY_MAX_KEYS) key = TELEMETRY_OVERFLOW_KEY;
        }

        if (!this._agg.byIdentity.has(key)) {
            this._agg.byIdentity.set(key, freshBucket());
        }
        const b = this._agg.byIdentity.get(key)!;
        const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : 0;
        b.requests++;
        b.totalDurationMs += durationMs;
        countCapped(b.statusCodes, String(event.status));
        countCapped(b.operations, String(event.operation));
        countCapped(b.hosts, String(event.host));

        countCappedMap(this._agg.byHost, String(event.host));
        countCappedMap(this._agg.byOperation, String(event.operation));
        this._agg.total++;
    }

    /** The current window's counts, in the shape written to the chain and to gateway-usage.json. */
    private _requestCounts(): WindowRequestCounts {
        const identities: Record<string, IdentityUsageBucket> = {};
        let anonymous: IdentityUsageBucket = bucketToPublic(freshBucket());
        for (const [key, bucket] of this._agg.byIdentity) {
            if (key === null) anonymous = bucketToPublic(bucket);
            else identities[key] = bucketToPublic(bucket);
        }
        return {
            total:       this._agg.total,
            anonymous,
            identities,
            byHost:      Object.fromEntries(this._agg.byHost),
            byOperation: Object.fromEntries(this._agg.byOperation),
        };
    }

    /**
     * Writes the window's single aggregate entry to `surface.usage.window` and resets the counts.
     *
     * Called automatically by the internal timer; may also be invoked directly
     * (e.g. during tests or on graceful shutdown for a final snapshot).
     */
    flushWindowSnapshot(): void {
        // Requests still queued for the next tick belong to this window.
        if (this._pending.length) this._drainNow();
        const now  = Date.now();
        const snap = getSurfaceTelemetrySnapshot();

        const payload: Omit<WindowLedgerEntry, 'sig'> = {
            windowStartedAt: this._windowStart,
            windowEndedAt:   now,
            requestRate:     snap.usage.requestRatePer10s,
            cpuRatio:        snap.usage.cpu,
            memoryRatio:     computeMemoryRatio(),
            pressureCpu:     snap.pressure.cpu,
            requests:        this._requestCounts(),
        };

        // Advance the window start for the next snapshot.
        this._windowStart = now;

        try {
            appendSemanticMemory({
                namespace: this._resolveNamespace(),
                path:      'surface.usage.window',
                data:      { ...payload, sig: this._sign(payload as Record<string, unknown>) } satisfies WindowLedgerEntry,
            });
        } catch {
            // Silently ignore — telemetry must never crash the daemon.
        }

        // Level 3: export aggregated gateway-usage.json if NETGET_DATA_DIR is set.
        // Runs after the ledger write so any failure here never blocks Level 2.
        this._exportToFile(payload);

        // Reset the rolling aggregate for the next window.
        this._agg = freshAggregate();
    }

    /**
     * Closes the open window if it counted any request (on shutdown, before the snapshot is saved), so those counts
     * are not lost with the process.  An idle window writes nothing.
     */
    closeWindowIfActive(): void {
        if (this._pending.length) this._drainNow();
        if (this._agg.total > 0) this.flushWindowSnapshot();
    }

    // ── File export (Level 3) ─────────────────────────────────────────────────

    /**
     * Atomically writes `gateway-usage.json` + `gateway-usage.version` to
     * `$NETGET_DATA_DIR/runtime/`.
     *
     * This is the same atomic-rename + version-file pattern used by
     * `domain-map.json` and `gateway-claims.json` so nginx Lua workers
     * hot-reload the table without a worker restart.
     *
     * Called automatically at the end of every window flush when `NETGET_DATA_DIR`
     * is set in the environment.  Safe to call manually at any point.
     *
     * @param windowPayload - The Level 2 payload from the most recent window flush.
     */
    _exportToFile(windowPayload: Omit<WindowLedgerEntry, 'sig' | 'requests'>): void {
        const netgetDir = (process.env.NETGET_DATA_DIR ?? '').trim();
        if (!netgetDir) return;

        const counts = this._requestCounts();

        const snapBase: Omit<GatewayUsageSnapshot, 'version' | 'updatedAt'> = {
            gatewayId:       normalizeHostname(os.hostname()),
            windowStartedAt: windowPayload.windowStartedAt,
            windowEndedAt:   windowPayload.windowEndedAt,
            totalRequests:   counts.total,
            identities:      counts.identities,
            anonymous:       counts.anonymous,
            byHost:          counts.byHost,
            byOperation:     counts.byOperation,
            system: {
                cpuRatio:    windowPayload.cpuRatio,
                memoryRatio: windowPayload.memoryRatio,
                pressureCpu: windowPayload.pressureCpu,
            },
        };

        const now = Date.now();
        const snapshot: GatewayUsageSnapshot = {
            ...snapBase,
            version:   computeSnapshotVersion(snapBase),
            updatedAt: now,
        };

        const runtimeDir  = path.join(netgetDir, 'runtime');
        const outPath     = path.join(runtimeDir, 'gateway-usage.json');
        const versionPath = path.join(runtimeDir, 'gateway-usage.version');
        const tmpPath     = `${outPath}.tmp`;

        try {
            fs.mkdirSync(runtimeDir, { recursive: true });
            fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
            fs.renameSync(tmpPath, outPath);
            fs.writeFileSync(versionPath, snapshot.version, 'utf8');
        } catch {
            // Never let a file write failure crash the daemon.
        }
    }

    /**
     * Returns the path to `gateway-usage.json` when `NETGET_DATA_DIR` is set,
     * or `null` when the file export is not configured.
     */
    get usageFilePath(): string | null {
        const d = (process.env.NETGET_DATA_DIR ?? '').trim();
        return d ? path.join(d, 'runtime', 'gateway-usage.json') : null;
    }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide usage ledger instance.
 *
 * Import and call `defaultUsageLedger.start()` once during daemon bootstrap
 * (after the kernel has been initialised).  No recording happens until `start()`
 * is called, so importing this module before the kernel is ready is safe.
 *
 * @example
 * ```typescript
 * import { defaultUsageLedger } from './resources/usageLedger.js';
 *
 * // In monad bootstrap, after ensureRootSemanticBootstrap():
 * defaultUsageLedger.start();
 * ```
 */
export const defaultUsageLedger = new ResourceUsageLedger();
