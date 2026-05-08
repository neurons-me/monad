/**
 * selfMapping.test.ts — Self-Node Identity and Dispatch Routing
 *
 * WHAT IS "SELF MAPPING"?
 * Every running monad.ai instance has a SELF identity: it knows:
 *   - Its namespace (the identity it serves, e.g., "example.cleaker.me")
 *   - Its endpoint (where it listens, e.g., "http://localhost:8161")
 *   - Its tags (what kind of node it is: "desktop", "primary", "local")
 *   - Its hostname (the machine's DNS name, e.g., "example-host.local")
 *
 * When a request arrives for a namespace + selector, the self-mapper decides:
 *   "local"   → this daemon should handle it (namespace matches + tags match)
 *   "remote"  → this daemon serves the namespace but NOT with these tags (send to mesh)
 *   "foreign" → this namespace belongs to someone else entirely (look it up in the mesh)
 *
 * SELECTOR SYNTAX:
 * A selector string targets a specific type of node. Examples:
 *   "device:desktop"          → only nodes with tag "desktop"
 *   "device:macbook,iphone"   → nodes with tag "macbook" OR "iphone"
 *   "device:desktop;cloud"    → nodes that are BOTH "desktop" AND "cloud" (AND grouping)
 *   "host:edge"               → nodes with tag "host:edge"
 *   "device:macbook,iphone|cloud;host:edge"  → (macbook OR iphone) OR (cloud AND host:edge)
 *
 * WHAT IS `loadSelfNodeConfig`?
 * Loads or generates the daemon's self identity configuration from disk.
 * If no identity exists yet, it generates one from the machine's hostname and port.
 * The generated identity is then persisted so it's stable across restarts.
 *
 * WHAT WE TEST:
 *   1. Selector parsing (DNF format with typed and bare tags)
 *   2. Local dispatch: selector matches this node's tags → "local"
 *   3. Remote dispatch: identity matches but selector doesn't → "remote"
 *   4. Foreign dispatch: namespace doesn't belong to this node → "foreign"
 *   5. buildSelfSurfaceEntry: assembles the surface descriptor for this node
 *   6. loadSelfNodeConfig: auto-generates and persists identity from hostname
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSelfSurfaceEntry,
  loadSelfNodeConfig,
  parseSelectorGroups,
  resolveSelfDispatch,
  type SelfNodeConfig,
} from "../src/http/selfMapping";

// Fixed self configuration used across most tests.
// In production, this comes from environment variables or the persisted self.json.
const SELF: SelfNodeConfig = {
  identity: "example.cleaker.me",        // this daemon's namespace
  tags: ["desktop", "local", "primary"], // what kind of node this is
  endpoint: "http://localhost:8161",      // where to find this daemon
  hostname: "example-host.local",         // machine DNS name
  configPath: "/tmp/self.json",           // where config was loaded from
};

describe("self mapping", () => {

  it("parses DNF selector groups with typed and bare tags", () => {
    // WHAT: Parse the complex selector string:
    //   "device:macbook,iphone|cloud;host:edge"
    //
    // DNF = Disjunctive Normal Form: a list of OR groups, each containing AND clauses.
    //
    // Structure:
    //   "device:macbook,iphone"  = type:"device", values:["macbook","iphone"]
    //   "|"                       = OR (separates groups)
    //   "cloud"                  = bare tag: type:"tag", values:["cloud"]
    //   ";"                       = AND (joins clauses within a group)
    //   "host:edge"              = type:"host", values:["edge"]
    //
    // Parsed result:
    //   Group 1: [{ type:"device", values:["macbook","iphone"] }]
    //   Group 2: [{ type:"tag", values:["cloud"] }, { type:"host", values:["edge"] }]
    //
    // This means: "nodes that are (macbook OR iphone) OR nodes that are (cloud AND host:edge)"
    expect(parseSelectorGroups("device:macbook,iphone|cloud;host:edge")).toEqual([
      [{ type: "device", values: ["macbook", "iphone"] }],
      [
        { type: "tag", values: ["cloud"] },
        { type: "host", values: ["edge"] },
      ],
    ]);
  });

  it("matches the local node when the selector targets one of its tags", () => {
    // WHAT: Selector "device:desktop" — SELF has tag "desktop" → mode="local"
    //       Selector "iphone,desktop"  — SELF has "desktop" (alternative matched) → mode="local"
    //
    // resolveSelfDispatch returns:
    //   mode:                "local" (this daemon handles it)
    //   hasInstanceSelector: true (there was an instance-level tag filter)
    //   matched:             ["desktop"] (which tags satisfied the selector)
    //   required:            ["desktop"] (what the selector required)
    //
    // WHY: "local" means the request stays on this machine. The bridge won't forward it.
    //      This is the fast path — no mesh lookup needed, just serve from local kernel.
    expect(resolveSelfDispatch("example.cleaker.me", "device:desktop", SELF)).toMatchObject({
      mode: "local",
      hasInstanceSelector: true,
      matched: ["desktop"],
      required: ["desktop"],
    });

    // Alternative selector: "iphone,desktop" — "desktop" matches as the second alternative
    expect(resolveSelfDispatch("example.cleaker.me", "iphone,desktop", SELF)).toMatchObject({
      mode: "local",
      hasInstanceSelector: true,
      matched: ["desktop"],
    });
  });

  it("marks the request as remote when the identity matches but the instance does not", () => {
    // WHAT: Namespace "example.cleaker.me" matches SELF's identity, but
    //       selector "device:iphone" — SELF has tag "desktop", NOT "iphone".
    //       → mode="remote"
    //
    // mode="remote" means: "this is our namespace but we're not the right instance type.
    // There's probably another monad with the 'iphone' tag that can handle this."
    //
    // The bridge will look in the mesh for another monad that:
    //   1. Serves "example.cleaker.me" (the namespace)
    //   2. Has tag "iphone" (the instance selector)
    expect(resolveSelfDispatch("example.cleaker.me", "device:iphone", SELF)).toMatchObject({
      mode: "remote",
      hasInstanceSelector: true,
      required: ["iphone"],
    });
  });

  it("keeps foreign namespaces outside the local identity hub", () => {
    // WHAT: Namespace "bella.cleaker.me" is NOT SELF's identity ("example.cleaker.me").
    //       → mode="foreign"
    //
    // mode="foreign" means: "this namespace belongs to a completely different user.
    // Look in the mesh for whoever claims bella.cleaker.me — don't try to serve locally."
    //
    // hasInstanceSelector: true (there was a tag filter, but it's irrelevant here
    //                            because the namespace doesn't match at all)
    expect(resolveSelfDispatch("bella.cleaker.me", "device:macbook", SELF)).toMatchObject({
      mode: "foreign",
      hasInstanceSelector: true,
      required: ["macbook"],
    });
  });

  it("builds a resolved surface entry from the answering host", () => {
    // WHAT: buildSelfSurfaceEntry assembles a structured "surface descriptor" for this daemon.
    //       The surface is what gets returned in GET /__surface responses — it tells callers
    //       what resources and capabilities this node offers.
    //
    // Parameters:
    //   self:             the SELF config (identity, tags, endpoint, hostname)
    //   origin:           the HTTP address the request came from
    //   fallbackHost:     the hostname to use if origin doesn't have one
    //   requestNamespace: the namespace from the HTTP request
    //   now:              a fixed timestamp for deterministic testing
    //
    // Expected surface entry fields:
    //   hostId:      "example-host.local"  (the machine's DNS name)
    //   type:        "desktop"             (from SELF.tags[0])
    //   trust:       "owner"               (local namespace = full owner trust)
    //   resources:   ["public_ingress", "keychain", "filesystem", "gpu", "camera", "local_lan"]
    //                (the capabilities a desktop node typically has)
    //   capacity:    { cpuCores: null, ramGb: null, ... } (not yet reported → nulls)
    //   status:      { availability: "online", latencyMs: null, syncState: "current", lastSeen: 1234 }
    //   namespace:   "http://example-host.local:8161" (the host's addressing URL)
    //   endpoint:    "http://localhost:8161"          (the local binding address)
    //   rootName:    "cleaker.me"                     (extracted from SELF.identity)
    expect(
      buildSelfSurfaceEntry({
        self: SELF,
        origin: "http://localhost:8161",
        fallbackHost: "example-host.local",
        requestNamespace: "localhost",
        now: 1234,
      }),
    ).toMatchObject({
      hostId: "example-host.local",
      type: "desktop",
      trust: "owner",
      resources: ["public_ingress", "keychain", "filesystem", "gpu", "camera", "local_lan"],
      capacity: {
        cpuCores: null,
        ramGb: null,
        storageGb: null,
        bandwidthMbps: null,
      },
      status: {
        availability: "online",
        latencyMs: null,
        syncState: "current",
        lastSeen: 1234,
      },
      namespace: "http://example-host.local:8161",
      endpoint: "http://localhost:8161",
      rootName: "cleaker.me",
    });
  });

  it("derives a deterministic Ed25519 keypair from SEED — same seed = same monad identity", () => {
    // WHAT: When SEED is set and no explicit keypair exists, loadSelfNodeConfig derives
    //       the Ed25519 keypair via HKDF-SHA256(seed, info='monad.ai/ed25519/v1').
    //       Same SEED on any machine → same keypair → same monadId → same mesh identity.
    //
    // This is KDF domain separation: compound_seed (from this.me) → Ed25519 keypair
    // without compromise risk between domains.

    const seed = "a".repeat(64); // 64 hex chars = 32 bytes
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "monad-kdf-a-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "monad-kdf-b-"));

    try {
      const env1: NodeJS.ProcessEnv = { SEED: seed };
      const result1 = loadSelfNodeConfig({ cwd: cwd1, env: env1, hostname: "host-a.local", port: 8161 });

      const env2: NodeJS.ProcessEnv = { SEED: seed };
      const result2 = loadSelfNodeConfig({ cwd: cwd2, env: env2, hostname: "host-b.local", port: 8161 });

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Same seed on two different machines → same keypair and same monadId
      expect(env1.MONAD_PUBLIC_KEY).toBe(env2.MONAD_PUBLIC_KEY);
      expect(env1.MONAD_ID).toBe(env2.MONAD_ID);

      // monadId is deterministic and non-empty
      expect(env1.MONAD_ID).toMatch(/^monad:[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("produces different monad identities for different SEEDs", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "monad-kdf-c-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "monad-kdf-d-"));

    try {
      const env1: NodeJS.ProcessEnv = { SEED: "a".repeat(64) };
      const env2: NodeJS.ProcessEnv = { SEED: "b".repeat(64) };
      loadSelfNodeConfig({ cwd: cwd1, env: env1, hostname: "host.local", port: 8161 });
      loadSelfNodeConfig({ cwd: cwd2, env: env2, hostname: "host.local", port: 8161 });

      expect(env1.MONAD_PUBLIC_KEY).not.toBe(env2.MONAD_PUBLIC_KEY);
      expect(env1.MONAD_ID).not.toBe(env2.MONAD_ID);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("falls back to random keypair when SEED is not set (backwards compatible)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monad-kdf-e-"));

    try {
      const env: NodeJS.ProcessEnv = {}; // no SEED
      loadSelfNodeConfig({ cwd, env, hostname: "host.local", port: 8161 });

      // Still gets a valid monadId — just random, not deterministic
      expect(env.MONAD_ID).toMatch(/^monad:[0-9a-f]{64}$/);
      expect(env.MONAD_PUBLIC_KEY).toBeTruthy();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("autogenerates and persists a daemon identity when none is configured", () => {
    // WHAT: loadSelfNodeConfig with no existing config file and no env vars.
    //       The function should:
    //   1. Derive identity from hostname ("Suis-MacBook-Air.local" → "suis-macbook-air.local")
    //   2. Build an endpoint from the derived identity and port (8161)
    //   3. Write the config to "env/self.json" inside the cwd
    //   4. Set MONAD_SELF_IDENTITY env var to the derived identity
    //   5. Return a stable SelfNodeConfig object
    //
    //   THEN: Call loadSelfNodeConfig again (simulating a restart).
    //         The same identity must be returned (identity persists across restarts).
    //
    // WHY: Without auto-generation, a fresh install would need manual identity setup.
    //      The hostname-based derivation gives a stable, human-readable identity
    //      without requiring any configuration. The persistence in env/self.json
    //      ensures the identity doesn't change on every restart (which would break
    //      cryptographic claims and mesh routing).
    //
    // Hostname normalization: "Suis-MacBook-Air.local" → "suis-macbook-air.local"
    //   (lowercase, no change to dots or hyphens — valid DNS label)

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monad-self-"));
    const env: NodeJS.ProcessEnv = {}; // empty env — no pre-configured identity

    try {
      const loaded = loadSelfNodeConfig({
        cwd,
        env,
        hostname: "Suis-MacBook-Air.local",
        port: 8161,
      });

      expect(loaded).not.toBeNull();
      expect(loaded?.identity).toBe("suis-macbook-air.local");        // normalized hostname
      expect(loaded?.endpoint).toBe("http://suis-macbook-air.local:8161"); // derived endpoint
      expect(loaded?.configPath).toBe(path.join(cwd, "env/self.json")); // where config was written
      expect(env.MONAD_SELF_IDENTITY).toBe(loaded?.identity);           // env var set

      // The config file must actually exist on disk
      expect(fs.existsSync(path.join(cwd, "env/self.json"))).toBe(true);

      // The file contents must have the identity field
      const persisted = JSON.parse(
        fs.readFileSync(path.join(cwd, "env/self.json"), "utf8"),
      ) as { identity?: string };
      expect(persisted.identity).toBe(loaded?.identity);

      // Simulate a restart: call loadSelfNodeConfig again with fresh env.
      // The identity should be IDENTICAL to the first call (loaded from the persisted file).
      const reloaded = loadSelfNodeConfig({
        cwd,
        env: {},   // fresh env (simulating daemon restart)
        hostname: "Suis-MacBook-Air.local",
        port: 8161,
      });
      expect(reloaded?.identity).toBe(loaded?.identity); // same identity after restart

    } finally {
      // Clean up temp directory
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
