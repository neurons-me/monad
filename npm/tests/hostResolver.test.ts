/**
 * hostResolver.test.ts — Resolving HTTP Hosts to Canonical me:// Addresses
 *
 * WHAT IS resolveHostToMeUri?
 * When an HTTP request arrives, its `Host` header contains something like:
 *   "suign.cleaker.me"  or  "foo.bar.cleaker.me"  or  "localhost:8161"
 *
 * The host resolver decides: is this a valid namespace? Which user does it belong to?
 * If valid, it returns a canonical NRP address: "me://suign.cleaker.me"
 *
 * CONCEPTS:
 *
 *   knownSpaces: the list of namespace root domains this daemon serves.
 *     For example: ["cleaker.me"] means this daemon handles *.cleaker.me namespaces.
 *     You can configure multiple spaces: ["cleaker.me", "neurons.me", "bar.cleaker.me"]
 *
 *   namespace: a fully qualified identity address like "suign.cleaker.me"
 *     = username "suign" in space "cleaker.me"
 *
 *   canonical: the NRP form of the namespace: "me://suign.cleaker.me"
 *
 *   handle: just the username part ("suign" from "suign.cleaker.me")
 *
 *   space: the root domain used for this namespace ("cleaker.me")
 *
 * WHAT WE TEST (4 cases):
 *   1. Single-label host in a known space → resolved as namespace
 *   2. Multi-label host (sub-user) in a single-space config → rejected as NOT_CANONICAL
 *   3. Multi-label host when a matching sub-space is known → resolved correctly
 *   4. "localhost" → rejected as TRANSPORT_ONLY_HOST (not an identity)
 */

import { resolveHostToMeUri } from "../src/runtime/hostResolver.js";

describe("canonical host resolver", () => {

  it("projects a single-label host into a canonical namespace", () => {
    // WHAT: "suign.cleaker.me" with knownSpaces=["cleaker.me"].
    //   - The host is "suign.cleaker.me"
    //   - Strip the known space "cleaker.me" → prefix = ["suign"]
    //   - One prefix label → this is username "suign" in space "cleaker.me"
    //   - Result: namespace = "suign.cleaker.me", canonical = "me://suign.cleaker.me"
    //
    // WHY: The most common case. Every user with a namespace like "alice.cleaker.me"
    //      goes through this path. If this doesn't resolve correctly, all user routing fails.
    expect(
      resolveHostToMeUri("https://suign.cleaker.me", {
        knownSpaces: ["cleaker.me"],
      }),
    ).toEqual({
      ok: true,
      kind: "namespace",
      host: "suign.cleaker.me",
      namespace: "suign.cleaker.me",
      handle: "suign",        // the username
      space: "cleaker.me",    // the root domain
      canonical: "me://suign.cleaker.me",
      knownSpaces: ["cleaker.me"],
    });
  });

  it("rejects multi-label projection when only the root space is known", () => {
    // WHAT: "foo.bar.cleaker.me" with knownSpaces=["cleaker.me"].
    //   - Strip "cleaker.me" → prefix = ["foo", "bar"] (2 labels)
    //   - "cleaker.me" only supports single-label usernames
    //   - Result: ok=false, reason=NOT_CANONICAL_NAMESPACE
    //
    // WHY: "foo.bar.cleaker.me" is ambiguous when only "cleaker.me" is known.
    //      Is "foo" a user in sub-space "bar.cleaker.me"? Or is "foo.bar" the username?
    //      Without knowing that "bar.cleaker.me" is a valid sub-space, we can't tell.
    //      Rejecting prevents incorrect routing.
    //
    // matchedSpace: "cleaker.me"   → the space that matched the suffix
    // prefixLabels: ["foo", "bar"] → the labels before the matched space
    expect(
      resolveHostToMeUri("foo.bar.cleaker.me", {
        knownSpaces: ["cleaker.me"],
      }),
    ).toMatchObject({
      ok: false,
      host: "foo.bar.cleaker.me",
      reason: "NOT_CANONICAL_NAMESPACE",
      matchedSpace: "cleaker.me",
      prefixLabels: ["foo", "bar"],
    });
  });

  it("prefers the longest known-space suffix deterministically", () => {
    // WHAT: "foo.bar.cleaker.me" with knownSpaces=["cleaker.me", "bar.cleaker.me"].
    //   Both spaces are suffixes of "foo.bar.cleaker.me", but:
    //     - "bar.cleaker.me" is longer (3 labels vs 2 labels)
    //     - Longer match wins (more specific)
    //   Strip "bar.cleaker.me" → prefix = ["foo"] (1 label) → username "foo"
    //   Result: namespace = "foo.bar.cleaker.me", space = "bar.cleaker.me"
    //
    // WHY: "Longest suffix wins" is the standard DNS-style resolution rule.
    //      It's deterministic (no ambiguity when multiple spaces could match)
    //      and gives the most specific result. This allows nested namespace hierarchies:
    //      "cleaker.me" → top-level, "bar.cleaker.me" → a specific sub-network.
    expect(
      resolveHostToMeUri("foo.bar.cleaker.me", {
        knownSpaces: ["cleaker.me", "bar.cleaker.me"],
      }),
    ).toEqual({
      ok: true,
      kind: "namespace",
      host: "foo.bar.cleaker.me",
      namespace: "foo.bar.cleaker.me",
      handle: "foo",              // username in the sub-space
      space: "bar.cleaker.me",    // the matched sub-space (longer suffix wins)
      canonical: "me://foo.bar.cleaker.me",
      knownSpaces: ["cleaker.me", "bar.cleaker.me"],
    });
  });

  it("treats localhost as transport-only", () => {
    // WHAT: "localhost:8161" with knownSpaces=["cleaker.me"].
    //   - "localhost" is a transport address (HTTP server binding), not an identity
    //   - It's not in any known space → TRANSPORT_ONLY_HOST
    //
    // WHY: "localhost" means "this machine's loopback interface". It's not a user
    //      identity — it's just where the HTTP server listens. Requests to localhost
    //      should use the daemon's self-identity (e.g., "monad-9f094393.local"),
    //      not be treated as a namespace.
    //
    //      Without this check, a request to http://localhost:8161/profile would
    //      try to find a user named "localhost" — nonsensical.
    expect(
      resolveHostToMeUri("localhost:8161", {
        knownSpaces: ["cleaker.me"],
      }),
    ).toMatchObject({
      ok: false,
      host: "localhost",
      reason: "TRANSPORT_ONLY_HOST",
    });
  });
});
