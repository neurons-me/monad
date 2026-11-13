/**
 * Tests for ResourceUsageLedger.
 *
 * Covers:
 *   - signing key: SEED-derived vs ephemeral
 *   - start / stop lifecycle (isRunning, idempotent start)
 *   - publicKeyHex is a valid importable Ed25519 SPKI key
 *   - requests are counted, never written one by one (no surface.usage.requests entries)
 *   - one window entry carries the window's counts; signature covers them; keys capped
 *   - interval policy (default 10 min, minimum 1 min) applied by start()
 *   - Level 2: flushWindowSnapshot() → entry at surface.usage.window
 *   - Level 2: window timing (endedAt > startedAt, start resets)
 *   - stop() prevents further events from being recorded
 */

import assert from "assert";
import crypto from "crypto";
import fs     from "fs";
import os     from "os";
import path   from "path";
import {
    ResourceUsageLedger,
    stableJson,
    type WindowLedgerEntry,
    type GatewayUsageSnapshot,
} from "../src/resources/usageLedger.js";
import { recordSurfaceRequest } from "../src/http/surfaceTelemetry.js";
import { HostTelemetryLedger } from "../src/resources/hostTelemetryLedger.js";
import {
    TELEMETRY_DEFAULT_INTERVAL_MS,
    TELEMETRY_MAX_KEYS,
    TELEMETRY_MIN_INTERVAL_MS,
    TELEMETRY_OVERFLOW_KEY,
    resolveTelemetryIntervalMs,
} from "../src/resources/telemetryPolicy.js";
import { vi } from "vitest";
import { listSemanticMemoriesByNamespace } from "../src/claim/memoryStore.js";

// The test setup (tests/setup.ts) sets process.env.ME_NAMESPACE = "cleaker.me"
const NS = process.env.ME_NAMESPACE ?? "cleaker.me";

// ---------------------------------------------------------------------------
// Helper: wait one setImmediate cycle so _drainNow() fires
// ---------------------------------------------------------------------------

function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Helper: stableJson verification (same algorithm as the signer)
// ---------------------------------------------------------------------------

function countRequestEntries(): number {
    return listSemanticMemoriesByNamespace(NS, {
        prefix: "surface.usage.requests",
        limit: 5_000,
    }).length;
}

function countWindowEntries(): number {
    return listSemanticMemoriesByNamespace(NS, {
        prefix: "surface.usage.window",
        limit: 5_000,
    }).length;
}

function lastWindowEntry(): WindowLedgerEntry | undefined {
    const rows = listSemanticMemoriesByNamespace(NS, {
        prefix: "surface.usage.window",
        limit: 5_000,
    });
    return rows.length ? (rows[rows.length - 1]!.data as WindowLedgerEntry) : undefined;
}

// ---------------------------------------------------------------------------
// stableJson — canonical serialisation
// ---------------------------------------------------------------------------

test("stableJson: sorts object keys recursively", () => {
    const out = stableJson({ z: 1, a: 2, m: 3 });
    assert.equal(out, '{"a":2,"m":3,"z":1}');
});

test("stableJson: handles arrays without sorting elements", () => {
    const out = stableJson([3, 1, 2]);
    assert.equal(out, "[3,1,2]");
});

test("stableJson: handles null and primitives", () => {
    assert.equal(stableJson(null), "null");
    assert.equal(stableJson(42), "42");
    assert.equal(stableJson("hello"), '"hello"');
});

test("stableJson: nested objects sort keys at each level", () => {
    const out = stableJson({ b: { y: 1, x: 2 }, a: 0 });
    assert.equal(out, '{"a":0,"b":{"x":2,"y":1}}');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("isRunning is false before start()", () => {
    const ledger = new ResourceUsageLedger();
    assert.equal(ledger.isRunning, false);
});

test("start() flips isRunning and returns this", () => {
    const ledger = new ResourceUsageLedger();
    const returned = ledger.start(60_000);
    assert.equal(returned, ledger, "start() returns this for chaining");
    assert.equal(ledger.isRunning, true);
    ledger.stop();
});

test("stop() flips isRunning back to false", () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    ledger.stop();
    assert.equal(ledger.isRunning, false);
});

test("start() is idempotent — calling twice keeps same key and state", () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    const key = ledger.publicKeyHex;
    ledger.start(60_000);   // second call: no-op
    assert.equal(ledger.publicKeyHex, key);
    assert.equal(ledger.isRunning, true);
    ledger.stop();
});

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

test("publicKeyHex is a valid importable Ed25519 SPKI public key", () => {
    const ledger = new ResourceUsageLedger();
    const pubKey = crypto.createPublicKey({
        key:    Buffer.from(ledger.publicKeyHex, "hex"),
        format: "der",
        type:   "spki",
    });
    assert.equal(pubKey.asymmetricKeyType, "ed25519");
});

test("SEED-derived key is deterministic across instances", () => {
    // Both instances are created with the same process.env.SEED (set in setup.ts)
    const a = new ResourceUsageLedger();
    const b = new ResourceUsageLedger();
    assert.equal(a.publicKeyHex, b.publicKeyHex, "same SEED → same derived public key");
});

// ---------------------------------------------------------------------------
// Requests are counted, never written one by one (telemetryPolicy.ts)
// ---------------------------------------------------------------------------

function req(over: Partial<Parameters<typeof recordSurfaceRequest>[0]> = {}) {
    recordSurfaceRequest({
        method: "GET", url: "/__surface", status: 200, durationMs: 4,
        host: "127.0.0.1", namespace: NS, operation: "read",
        nrp: "", lens: "", forwardedHost: null,
        ...over,
    } as Parameters<typeof recordSurfaceRequest>[0]);
}

test("requests write no memory of their own: 300 probes add 0 entries at surface.usage.requests", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    const before = countRequestEntries();
    const windowsBefore = countWindowEntries();

    for (let i = 0; i < 300; i++) req();
    await tick();

    assert.equal(countRequestEntries(), before, "no per-request entries");
    assert.equal(countWindowEntries(), windowsBefore, "nothing written until the window closes");
    ledger.stop();
});

test("the window writes ONE entry carrying every request of the window, counted", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    const before = countWindowEntries();
    const HASH = "aabbcc001122deadbeef000000000000000000000000000000000000000000ff01";

    for (let i = 0; i < 120; i++) req();                                   // a probe
    for (let i = 0; i < 30; i++) req({ host: "cleaker.me", url: "/gateway-identity" }); // a poller
    req({ method: "POST", url: "/claims/action", status: 201, durationMs: 12, host: "cleaker.me", operation: "write", identityHash: HASH });
    // Still queued for the next tick when the window closes: counted in this window, not lost.
    ledger.flushWindowSnapshot();

    assert.equal(countWindowEntries(), before + 1, "exactly one window entry");
    const entry = lastWindowEntry()!;
    const counts = entry.requests!;
    assert.equal(counts.total, 151);
    assert.equal(counts.byHost["127.0.0.1"], 120);
    assert.equal(counts.byHost["cleaker.me"], 31);
    assert.equal(counts.byOperation.read, 150);
    assert.equal(counts.byOperation.write, 1);
    assert.equal(counts.anonymous.requests, 150);
    assert.equal(counts.identities[HASH]!.requests, 1, "identityHash kept in its own bucket");
    assert.equal(counts.identities[HASH]!.statusCodes["201"], 1);

    // The next window starts from zero.
    req();
    ledger.flushWindowSnapshot();
    assert.equal(lastWindowEntry()!.requests!.total, 1);
    ledger.stop();
});

test("window signature covers the counts: altering requests.total invalidates it", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    for (let i = 0; i < 5; i++) req();
    ledger.flushWindowSnapshot();
    const { sig, ...payload } = lastWindowEntry()!;
    const pubKey = crypto.createPublicKey({ key: Buffer.from(sig.pubKey, "hex"), format: "der", type: "spki" });
    const verify = (p: unknown) =>
        crypto.verify(null, Buffer.from(stableJson(p as Record<string, unknown>), "utf8"), pubKey, Buffer.from(sig.value, "base64"));
    assert.ok(verify(payload), "signature verifies");
    assert.equal(verify({ ...payload, requests: { ...payload.requests!, total: payload.requests!.total + 1 } }), false);
    ledger.stop();
});

test("client-chosen keys are capped: 80 distinct Host headers and 50 identities keep the entry bounded, totals exact", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    for (let i = 0; i < 80; i++) req({ host: `random-${i}.example` });
    for (let i = 0; i < 50; i++) req({ host: `h${i}`, identityHash: `id-${i}` });
    ledger.flushWindowSnapshot();
    const counts = lastWindowEntry()!.requests!;
    assert.equal(counts.total, 130);
    assert.ok(Object.keys(counts.byHost).length <= TELEMETRY_MAX_KEYS + 1, "byHost capped");
    assert.equal(Object.values(counts.byHost).reduce((a, b) => a + b, 0), 130, "no request lost to the cap");
    assert.ok(counts.byHost[TELEMETRY_OVERFLOW_KEY]! > 0);
    assert.ok(Object.keys(counts.identities).length <= TELEMETRY_MAX_KEYS + 1, "identities capped");
    const idTotal = Object.values(counts.identities).reduce((a, b) => a + b.requests, 0);
    assert.equal(idTotal + counts.anonymous.requests, 130, "identity buckets + anonymous = total");
    assert.ok(counts.identities[TELEMETRY_OVERFLOW_KEY]!.requests > 0, "identities past the cap share the overflow bucket");
    for (const b of [counts.anonymous, ...Object.values(counts.identities)]) {
        assert.ok(Object.keys(b.hosts).length <= TELEMETRY_MAX_KEYS + 1, "per-bucket hosts capped");
    }
    ledger.stop();
});

test("closeWindowIfActive(): an idle window writes nothing; an active one writes its counts once", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    const before = countWindowEntries();
    ledger.closeWindowIfActive();
    assert.equal(countWindowEntries(), before, "idle window: no entry");
    for (let i = 0; i < 7; i++) req();      // still queued (no tick): must be counted, not lost
    ledger.closeWindowIfActive();
    assert.equal(countWindowEntries(), before + 1);
    assert.equal(lastWindowEntry()!.requests!.total, 7);
    ledger.closeWindowIfActive();
    assert.equal(countWindowEntries(), before + 1, "nothing left to write");
    ledger.stop();
});

test("interval policy: default 10 min, never below 1 min, whatever is configured", () => {
    assert.equal(resolveTelemetryIntervalMs(undefined), TELEMETRY_DEFAULT_INTERVAL_MS);
    assert.equal(resolveTelemetryIntervalMs(""), TELEMETRY_DEFAULT_INTERVAL_MS);
    assert.equal(resolveTelemetryIntervalMs("not-a-number"), TELEMETRY_DEFAULT_INTERVAL_MS);
    assert.equal(resolveTelemetryIntervalMs("10000"), TELEMETRY_MIN_INTERVAL_MS, "the old 10 s default is clamped");
    assert.equal(resolveTelemetryIntervalMs(0), TELEMETRY_MIN_INTERVAL_MS);
    assert.equal(resolveTelemetryIntervalMs(-5), TELEMETRY_MIN_INTERVAL_MS);
    assert.equal(resolveTelemetryIntervalMs("600000"), 600_000);
    assert.equal(resolveTelemetryIntervalMs(3_600_000), 3_600_000);
});

test("start() applies the policy to the timer it arms (usage and host ledgers)", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
        const usage = new ResourceUsageLedger();
        usage.start(1_000);
        usage.stop();
        const host = new HostTelemetryLedger();
        const sample = vi.spyOn(host, "sampleNow").mockImplementation(() => {});
        host.start(5_000);
        host.stop();
        sample.mockRestore();
        const fresh = new ResourceUsageLedger();
        fresh.start();
        fresh.stop();
        const delays = spy.mock.calls.map((c) => c[1]);
        assert.deepEqual(delays.slice(-3), [TELEMETRY_MIN_INTERVAL_MS, TELEMETRY_MIN_INTERVAL_MS, TELEMETRY_DEFAULT_INTERVAL_MS]);
    } finally {
        spy.mockRestore();
    }
});

// ---------------------------------------------------------------------------
// Level 2 — window snapshots
// ---------------------------------------------------------------------------

test("Level 2: flushWindowSnapshot() writes to surface.usage.window", () => {
    const ledger = new ResourceUsageLedger();
    // Do NOT call start() — invoke the snapshot directly to avoid timer side-effects.

    const before = countWindowEntries();

    ledger.flushWindowSnapshot();

    const after = countWindowEntries();
    assert.ok(after > before, "window snapshot entry written");

    const entry = lastWindowEntry()!;
    assert.ok(typeof entry.windowStartedAt === "number", "windowStartedAt present");
    assert.ok(typeof entry.windowEndedAt   === "number", "windowEndedAt present");
    assert.ok(typeof entry.requestRate     === "number", "requestRate present");
    assert.ok(typeof entry.cpuRatio        === "number", "cpuRatio present");
    assert.ok(typeof entry.memoryRatio     === "number", "memoryRatio present");
    assert.ok(typeof entry.pressureCpu     === "number", "pressureCpu present");
    assert.ok(entry.windowEndedAt >= entry.windowStartedAt,
        "windowEndedAt ≥ windowStartedAt");
    assert.equal(entry.sig.alg, "ed25519", "sig.alg is ed25519");
    assert.ok(entry.sig.value.length > 0, "sig.value non-empty");
    assert.ok(entry.sig.pubKey.length > 0, "sig.pubKey non-empty");
});

test("Level 2: consecutive flushWindowSnapshot() resets window start", () => {
    const ledger = new ResourceUsageLedger();

    ledger.flushWindowSnapshot();
    const first = lastWindowEntry()!;

    // Small delay to ensure the second window has a later startedAt
    const now = Date.now();
    while (Date.now() - now < 2) { /* busy-wait 2ms */ }

    ledger.flushWindowSnapshot();
    const second = lastWindowEntry()!;

    assert.ok(
        second.windowStartedAt >= first.windowEndedAt,
        "second window start ≥ first window end (no gap / overlap)",
    );
    assert.ok(second.windowEndedAt > second.windowStartedAt,
        "second window endedAt > startedAt");
});

test("Level 2: window snapshot signature verifies", () => {
    const ledger = new ResourceUsageLedger();
    ledger.flushWindowSnapshot();

    const entry = lastWindowEntry()!;
    const { sig, ...payload } = entry;

    const pubKey = crypto.createPublicKey({
        key:    Buffer.from(sig.pubKey, "hex"),
        format: "der",
        type:   "spki",
    });

    const canonical = Buffer.from(stableJson(payload as unknown as Record<string, unknown>), "utf8");
    const valid = crypto.verify(null, canonical, pubKey, Buffer.from(sig.value, "base64"));

    assert.ok(valid, "window snapshot signature verifies against embedded public key");
});

// ---------------------------------------------------------------------------
// stop() guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Level 3 — rolling aggregate + file export
// ---------------------------------------------------------------------------

test("Level 3: _exportToFile writes gateway-usage.json when NETGET_DATA_DIR is set", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-usage-export-test-"));

    try {
        const saved = process.env.NETGET_DATA_DIR;
        process.env.NETGET_DATA_DIR = tmpDir;

        const ledger = new ResourceUsageLedger();
        ledger.start(60_000);

        const HASH = "aabbcc001122deadbeef000000000000000000000000000000000000000000ab01";

        // Fire two requests — one attributed, one anonymous
        recordSurfaceRequest({
            method: "GET", url: "/attributed", status: 200, durationMs: 30,
            host: "local.netget", namespace: NS, operation: "read",
            nrp: "", lens: "", forwardedHost: null,
            identityHash: HASH,
        });
        recordSurfaceRequest({
            method: "POST", url: "/anonymous", status: 201, durationMs: 15,
            host: "local.netget", namespace: NS, operation: "write",
            nrp: "", lens: "", forwardedHost: null,
        });

        await tick();

        // Flush window → triggers _exportToFile
        ledger.flushWindowSnapshot();

        const outPath = path.join(tmpDir, "runtime", "gateway-usage.json");
        const verPath = path.join(tmpDir, "runtime", "gateway-usage.version");

        assert.ok(fs.existsSync(outPath),  "gateway-usage.json created");
        assert.ok(fs.existsSync(verPath),  "gateway-usage.version created");

        const snap: GatewayUsageSnapshot = JSON.parse(fs.readFileSync(outPath, "utf8"));

        assert.ok(snap.totalRequests >= 2,   "totalRequests >= 2");
        assert.ok(snap.identities[HASH],     "attributed identity present");
        assert.ok(snap.identities[HASH]!.requests >= 1, "attributed requests counted");
        assert.ok(snap.anonymous.requests >= 1, "anonymous requests counted");
        assert.ok(snap.byHost["local.netget"] >= 2, "byHost counts present");
        assert.ok(snap.byOperation["read"]  >= 1, "read ops counted");
        assert.ok(snap.byOperation["write"] >= 1, "write ops counted");
        assert.ok(typeof snap.system.cpuRatio    === "number", "system.cpuRatio present");
        assert.ok(typeof snap.system.memoryRatio === "number", "system.memoryRatio present");
        assert.ok(typeof snap.system.pressureCpu === "number", "system.pressureCpu present");
        assert.ok(snap.version.length === 32, "version is 32 hex chars");
        assert.equal(snap.version, fs.readFileSync(verPath, "utf8"),
            "version file matches snapshot.version");
        assert.ok(snap.windowEndedAt >= snap.windowStartedAt, "window timing valid");

        ledger.stop();
        process.env.NETGET_DATA_DIR = saved;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Level 3: avgDurationMs is correct", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-usage-avg-test-"));

    try {
        const saved = process.env.NETGET_DATA_DIR;
        process.env.NETGET_DATA_DIR = tmpDir;

        const ledger = new ResourceUsageLedger();
        ledger.start(60_000);

        const HASH = "aabbcc001122deadbeef000000000000000000000000000000000000000000cd02";

        // Two requests: 100ms + 200ms → avg 150ms
        recordSurfaceRequest({ method: "GET", url: "/a", status: 200, durationMs: 100,
            host: "h", namespace: NS, operation: "read", nrp: "", lens: "",
            forwardedHost: null, identityHash: HASH });
        recordSurfaceRequest({ method: "GET", url: "/b", status: 200, durationMs: 200,
            host: "h", namespace: NS, operation: "read", nrp: "", lens: "",
            forwardedHost: null, identityHash: HASH });

        await tick();
        ledger.flushWindowSnapshot();

        const snap: GatewayUsageSnapshot = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "runtime", "gateway-usage.json"), "utf8")
        );

        const bucket = snap.identities[HASH]!;
        assert.equal(bucket.requests,        2,   "2 requests");
        assert.equal(bucket.totalDurationMs, 300, "total 300ms");
        assert.equal(bucket.avgDurationMs,   150, "avg 150ms");

        ledger.stop();
        process.env.NETGET_DATA_DIR = saved;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Level 3: aggregate resets after each window flush", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-usage-reset-test-"));

    try {
        const saved = process.env.NETGET_DATA_DIR;
        process.env.NETGET_DATA_DIR = tmpDir;

        const ledger = new ResourceUsageLedger();
        ledger.start(60_000);

        // First window: 3 requests
        for (let i = 0; i < 3; i++) {
            recordSurfaceRequest({ method: "GET", url: "/w1", status: 200, durationMs: 10,
                host: "h", namespace: NS, operation: "read", nrp: "", lens: "",
                forwardedHost: null });
        }
        await tick();
        ledger.flushWindowSnapshot();

        const snap1: GatewayUsageSnapshot = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "runtime", "gateway-usage.json"), "utf8")
        );

        // Second window: 1 request
        recordSurfaceRequest({ method: "GET", url: "/w2", status: 200, durationMs: 5,
            host: "h", namespace: NS, operation: "read", nrp: "", lens: "",
            forwardedHost: null });
        await tick();
        ledger.flushWindowSnapshot();

        const snap2: GatewayUsageSnapshot = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "runtime", "gateway-usage.json"), "utf8")
        );

        assert.ok(snap1.totalRequests >= 3,
            "first window captured ≥ 3 requests");
        assert.ok(snap2.totalRequests >= 1 && snap2.totalRequests < snap1.totalRequests,
            "second window captured fewer requests (aggregate reset between windows)");
        assert.notEqual(snap1.version, snap2.version,
            "version differs between windows");

        ledger.stop();
        process.env.NETGET_DATA_DIR = saved;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Level 3: usageFilePath returns path when NETGET_DATA_DIR is set", () => {
    const saved = process.env.NETGET_DATA_DIR;
    process.env.NETGET_DATA_DIR = "/tmp/test-netget-dir";

    const ledger = new ResourceUsageLedger();
    assert.ok(ledger.usageFilePath!.endsWith("gateway-usage.json"),
        "usageFilePath ends with gateway-usage.json");

    process.env.NETGET_DATA_DIR = saved;
});

test("Level 3: usageFilePath is null when NETGET_DATA_DIR is not set", () => {
    const saved = process.env.NETGET_DATA_DIR;
    delete process.env.NETGET_DATA_DIR;

    const ledger = new ResourceUsageLedger();
    assert.equal(ledger.usageFilePath, null, "usageFilePath is null without NETGET_DATA_DIR");

    process.env.NETGET_DATA_DIR = saved;
});

// ---------------------------------------------------------------------------
// stop() guard
// ---------------------------------------------------------------------------

test("stop() prevents further events from being written", async () => {
    const ledger = new ResourceUsageLedger();
    ledger.start(60_000);
    ledger.stop();

    const before = countRequestEntries();

    recordSurfaceRequest({
        method:       "GET",
        url:          "/should-not-appear-after-stop",
        status:       200,
        durationMs:   1,
        host:         "local.netget",
        namespace:    NS,
        operation:    "read",
        nrp:          "",
        lens:         "",
        forwardedHost: null,
    });

    await tick();

    const after = countRequestEntries();
    assert.equal(after, before, "no new entries written after stop()");
});
