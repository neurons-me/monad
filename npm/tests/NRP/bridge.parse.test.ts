/**
 * bridge.parse.test.ts — URL Parser for the Neural Routing Protocol
 *
 * WHAT IS THIS MODULE?
 * Every request in the mesh travels with an NRP address that looks like:
 *
 *   me://suis-macbook-air.local:read/profile/name
 *   ─── ─────────────────────── ──── ────────────
 *   protocol   namespace         op    path
 *
 * Think of it like a mailing address but for data operations:
 *   - "me://"  → the addressing scheme (like "https://")
 *   - "suis-macbook-air.local" → which node to talk to (namespace)
 *   - "read" → what operation to perform
 *   - "profile/name" → which piece of data to access
 *
 * `parseBridgeTarget` converts that string into a structured object so the
 * bridge can forward the request to the right place.
 *
 * WHAT WE TEST:
 * - Correct parsing of all parts (namespace, selector, path in both slash and dot notation)
 * - Edge cases: empty input, missing protocol prefix, paths starting with dots, nested paths
 * - Normalization: uppercase namespaces become lowercase
 * - The `nrp` field is always a canonical round-trip of the original address
 */

import { extractMonadFromPath, parseBridgeTarget } from "../../src/runtime/bridge.js";

describe("parseBridgeTarget — cleaker v3 (__ptr.target) API", () => {

  // ── Standard parsing ────────────────────────────────────────────────────────

  it("parses standard namespace:op/path", () => {
    // Give it the simplest possible NRP address and verify every field comes out correct.
    //
    // "me://suis-macbook-air.local:read/profile"
    //        ↑ namespace              ↑ op ↑ path
    //
    // pathSlash: path as it appears in a URL  → "profile"
    // pathDot:   path as a kernel key         → "profile"  (same here, no conversion needed)
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile");
    expect(r).not.toBeNull();
    expect(r!.namespace).toBe("suis-macbook-air.local");
    expect(r!.selector).toBe("read");
    expect(r!.pathSlash).toBe("profile");
    expect(r!.pathDot).toBe("profile");
  });

  it("parses dot-prefixed path (.mesh/monads)", () => {
    // Paths starting with a dot are internal mesh control paths.
    // ".mesh/monads" (slash form) ↔ ".mesh.monads" (dot form)
    //
    // The dot form is used as a key in the kernel tree:
    //   kernel["_.mesh.monads"] → list of known monads
    //
    // The slash form is what you see in a URL or HTTP path.
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/.mesh/monads");
    expect(r).not.toBeNull();
    expect(r!.pathSlash).toBe(".mesh/monads");
    expect(r!.pathDot).toBe(".mesh.monads");
  });

  it("parses __surface path", () => {
    // "__surface" is a special reserved path that returns the node's surface descriptor
    // (what resources, capabilities, and trust levels this node exposes).
    // Single segment → pathSlash and pathDot are identical.
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/__surface");
    expect(r).not.toBeNull();
    expect(r!.pathSlash).toBe("__surface");
    expect(r!.pathDot).toBe("__surface");
  });

  it("parses nested path into dot notation", () => {
    // Multi-segment paths use "/" in URLs but "." in the kernel tree.
    // Example: "profile/name" → the kernel key is "profile.name"
    //
    // This conversion matters because the kernel stores data as a dot-path tree:
    //   kernel["profile.name"] → "Ana"
    // NOT as nested directories:
    //   kernel["profile"]["name"] (that's not how it works)
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile/name");
    expect(r!.pathSlash).toBe("profile/name");
    expect(r!.pathDot).toBe("profile.name");
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("returns null for empty input", () => {
    // Empty string and whitespace-only strings are not valid NRP addresses.
    // The bridge uses null to mean "couldn't parse, don't forward".
    expect(parseBridgeTarget("")).toBeNull();
    expect(parseBridgeTarget("   ")).toBeNull();
  });

  it("normalizes namespace to lowercase", () => {
    // DNS hostnames are case-insensitive, but our kernel stores them lowercase.
    // If someone sends "SUIS-MACBOOK-AIR.LOCAL" we must still find the right node.
    // Normalization happens at parse time so the rest of the system never sees mixed case.
    const r = parseBridgeTarget("me://SUIS-MACBOOK-AIR.LOCAL:read/profile");
    expect(r?.namespace).toBe("suis-macbook-air.local");
  });

  it("accepts shorthand without me:// prefix", () => {
    // Some internal callers send the address without the protocol prefix.
    // "suis-macbook-air.local:read/profile" should parse the same as
    // "me://suis-macbook-air.local:read/profile".
    // This makes life easier for code that constructs NRP strings programmatically.
    const r = parseBridgeTarget("suis-macbook-air.local:read/profile");
    expect(r).not.toBeNull();
    expect(r!.namespace).toBe("suis-macbook-air.local");
  });

  // ── Canonical NRP output ────────────────────────────────────────────────────

  it("builds correct nrp", () => {
    // The `nrp` field on the parsed result is the canonical round-trip form.
    // No matter how the input was formatted, `nrp` is always "me://namespace:op/path".
    // This is what the system stores in logs and passes to other nodes.
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile");
    expect(r!.nrp).toBe("me://suis-macbook-air.local:read/profile");
  });

  it("nrp uses underscore for empty path", () => {
    // An NRP with an empty path ("me://ns:read/") is unusual but shouldn't crash.
    // The canonical form must still produce a valid string, so the underscore
    // acts as a placeholder. Exact form is up to the impl, but it must end
    // with something (not just a trailing slash that looks like a directory).
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/");
    if (r) expect(r.nrp).toMatch(/_$/);
  });
});

// ── extractMonadFromPath ──────────────────────────────────────────────────────

describe("extractMonadFromPath — monad[frank] path syntax", () => {
  it("extracts monadId and empty remainingPath from bare monad[frank]", () => {
    const r = extractMonadFromPath("monad[frank]");
    expect(r).not.toBeNull();
    expect(r!.monadId).toBe("frank");
    expect(r!.remainingPath).toBe("");
  });

  it("extracts monadId and remainingPath from monad[frank]/projects/x", () => {
    const r = extractMonadFromPath("monad[frank]/projects/x");
    expect(r).not.toBeNull();
    expect(r!.monadId).toBe("frank");
    expect(r!.remainingPath).toBe("projects/x");
  });

  it("normalizes monadId to lowercase", () => {
    const r = extractMonadFromPath("monad[FRANK]");
    expect(r!.monadId).toBe("frank");
  });

  it("returns null for normal paths", () => {
    expect(extractMonadFromPath("profile/name")).toBeNull();
    expect(extractMonadFromPath(".mesh/monads")).toBeNull();
    expect(extractMonadFromPath("")).toBeNull();
  });

  it("returns null for malformed bracket syntax", () => {
    expect(extractMonadFromPath("monad[]")).toBeNull();
    expect(extractMonadFromPath("monad[frank")).toBeNull();
  });
});

describe("parseBridgeTarget — monad[frank] in path", () => {
  it("extracts monadId and monadScopePath from monad[frank]/projects/x", () => {
    const r = parseBridgeTarget("me://suign.cleaker.me:read/monad[frank]/projects/x");
    expect(r).not.toBeNull();
    expect(r!.monadId).toBe("frank");
    expect(r!.monadScopePath).toBe("projects/x");
    expect(r!.namespace).toBe("suign.cleaker.me");
  });

  it("monadId is absent for normal paths (no monad[name] syntax)", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile");
    expect(r).not.toBeNull();
    expect(r!.monadId).toBeUndefined();
    expect(r!.monadScopePath).toBeUndefined();
  });
});
