/**
 * hostProjection.test.ts — Host Devices as Semantic Memory
 *
 * WHAT IS HOST PROJECTION?
 * A "host" is a physical device (laptop, server, phone) that a user has registered
 * under their namespace. For example, Alice might have:
 *
 *   alice.cleaker.me/host.macbook.hostname = "suis-macbook-air.local"
 *   alice.cleaker.me/host.macbook.endpoint = "http://localhost:8161"
 *   alice.cleaker.me/host.macbook.status   = "authorized"
 *   alice.cleaker.me/host.macbook.capabilities = ["sync", "local_fs"]
 *
 * These are stored as individual semantic memories with paths like
 * "host.<host_key>.<field>". The projection system reads all these scattered
 * memories and assembles them into a structured Host object.
 *
 * WHAT IS listHostsByNamespace?
 * Given a namespace and username, it scans the memory store for all `host.*`
 * entries and groups them by host_key. The result is an array of structured Host
 * objects (one per registered device), not raw memory entries.
 *
 * WHAT IS getHostStatus?
 * A quick lookup that returns just the authorization status of a specific host
 * (identified by its fingerprint). Used by auth middleware to check if a device
 * is allowed to access the namespace.
 *
 * WHAT IS listHostMemoryHistory?
 * Returns the raw memory entries for a specific host (by fingerprint) in
 * chronological order. Useful for audit trails and debugging host registrations.
 *
 * WHAT WE TEST:
 * Write 7 host memory entries, then verify:
 *   - listHostsByNamespace assembles them into exactly 1 Host object with all fields
 *   - getHostStatus returns the correct authorization status
 *   - listHostMemoryHistory includes all 6+ host entries for this namespace
 */

import assert from "assert";
import crypto from "crypto";
import {
  appendSemanticMemory,
  getHostStatus,
  listHostMemoryHistory,
  listHostsByNamespace,
} from "../src/claim/memoryStore";

// Generate a unique username for each test run to avoid memory collisions
// when multiple tests write to the same in-memory store.
function uniqueUsername() {
  return `host-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

test("projects relative host memories inside the user namespace", () => {
  // WHAT: Simulate a user registering a device ("suis-macbook-air") in their namespace.
  //       The device registration is done by writing individual semantic memories
  //       (one per field), then we verify the projection system assembles them correctly.
  //
  // WHY THIS MATTERS:
  //   The host projection is used by:
  //     1. The /hosts UI page — shows the user's registered devices
  //     2. Auth middleware — checks if a requesting device is authorized
  //     3. The sync system — knows which devices to push updates to
  //
  //   If projection breaks, the user can't see their devices and sync fails.

  const username = uniqueUsername();
  const namespace = `${username}.cleaker.me`;
  const hostKey = "suis-macbook-air"; // the key used in memory paths
  const fingerprint = `fp-${crypto.randomBytes(6).toString("hex")}`; // unique device ID
  const timestamp = Date.now();

  // Write individual host field memories with incrementing timestamps
  // (timestamp ordering matters for history queries)
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.fingerprint`,
    operator: "=",
    data: fingerprint,
    timestamp,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.label`,
    operator: "=",
    data: hostKey,
    timestamp: timestamp + 1,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.hostname`,
    operator: "=",
    data: "suis-macbook-air.local",
    timestamp: timestamp + 2,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.local_endpoint`,
    operator: "=",
    data: "http://localhost:8161",
    timestamp: timestamp + 3,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.capabilities`,
    operator: "=",
    data: ["sync", "local_fs"], // array stored as JSON
    timestamp: timestamp + 4,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.status`,
    operator: "=",
    data: "authorized",
    timestamp: timestamp + 5,
  });
  appendSemanticMemory({
    namespace,
    path: `host.${hostKey}.last_seen`,
    operator: "=",
    data: timestamp + 6,
    timestamp: timestamp + 6,
  });

  // ── listHostsByNamespace ─────────────────────────────────────────────────────
  // WHAT: Scan all memories for this namespace, group by host_key, assemble Host objects.
  // EXPECT: Exactly 1 host (we only registered one device) with all 7 fields populated.

  const hosts = listHostsByNamespace(namespace, username);
  assert.equal(hosts.length, 1, "one host should be projected from relative host memories");

  const host = hosts[0];
  assert.equal(host.namespace, namespace);       // scoped to this user's namespace
  assert.equal(host.username, username);          // who owns this device
  assert.equal(host.host_key, hostKey);           // the key used in memory paths
  assert.equal(host.fingerprint, fingerprint);    // unique device fingerprint
  assert.equal(host.label, hostKey);              // human label (same as key here)
  assert.equal(host.hostname, "suis-macbook-air.local"); // DNS name of the machine
  assert.equal(host.local_endpoint, "http://localhost:8161"); // where to reach the daemon
  assert.equal(host.status, "authorized");        // this device is allowed

  // capabilities are stored as JSON (because the memory store is string-based),
  // so we parse them back to verify the array structure survived the round-trip
  assert.deepEqual(JSON.parse(host.capabilities_json), ["sync", "local_fs"]);

  // ── getHostStatus ────────────────────────────────────────────────────────────
  // WHAT: Look up just the authorization status for the device by fingerprint.
  // EXPECT: "authorized" — matches what we wrote in the `status` memory.
  //
  // This is called by auth middleware before every request from a registered device.
  // It must be fast (single lookup) and return the exact stored status string.

  assert.equal(
    getHostStatus(namespace, username, fingerprint),
    "authorized",
    "host status should resolve from the namespace-aware projection",
  );

  // ── listHostMemoryHistory ────────────────────────────────────────────────────
  // WHAT: Return raw memory entries for this device (by fingerprint), newest first.
  // EXPECT:
  //   - At least 6 entries (we wrote 7, but last_seen might not always be separate)
  //   - Includes the hostname entry (verifies path-based filtering works)
  //   - All entries are in this namespace (no cross-namespace leakage)
  //
  // WHY: The history view is used by the admin UI to show "when was this device
  //      registered and what changed?". If it leaks entries from other namespaces
  //      or missing entries from this namespace, the audit trail is unreliable.

  const history = listHostMemoryHistory(namespace, username, fingerprint, 20);
  assert.ok(history.length >= 6, "host history should include relative host.* events");
  assert.ok(
    history.some((memory) => memory.path === `host.${hostKey}.hostname`),
    "history should preserve relative hostname writes",
  );
  assert.ok(
    history.every((memory) => memory.namespace === namespace),
    "history should remain scoped to the user namespace",
  );
});
