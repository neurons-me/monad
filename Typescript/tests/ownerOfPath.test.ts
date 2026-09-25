/**
 * ownerOfPath.test.ts -- owner(p) from the formal model reviewed this
 * session: "the namespace whose prefix is the longest one contained in
 * path p". Pure, no network/kernel involved (Layer 1 of the two-layer
 * test methodology the review proposed) -- ownerLabelOfCanonicalPath /
 * ownerOfCanonicalPath in src/kernel/manager.ts are exactly the reference
 * model, built from the same regex isForeignUsersPrefixWrite has used
 * since the live root-into-Alice's-storage forgery this session (see
 * that function's own doc comment and rootWriteDirectionCheck.test.ts).
 *
 * Two cases here were added by review AFTER the first owner(p) pass, both
 * about a decision the equation's shorthand ("longest matching prefix")
 * can hide rather than make explicit:
 *
 *   1. Segment-boundary matching, not text-prefix matching -- "users.alice"
 *      must not be treated as owning "users.alicex.*" just because one
 *      string is a textual prefix of the other.
 *   2. The "unowned path" case is itself a decision: it belongs to the
 *      root namespace, asserted explicitly here, not left implicit.
 *
 * A third case (the bare "users.alice" pointer, no content beneath it)
 * was found while building this, not requested by either review -- see
 * ownerLabelOfCanonicalPath's own doc comment for why it resolves to
 * "alice", not root, matching the existing guard's original behavior
 * unchanged.
 *
 * Compound/multi-label namespace strings (would owner(p) ever need to
 * disambiguate BETWEEN two claimed namespaces for the "longest prefix"?)
 * were checked against parseNamespaceExpression/deriveConstantAndPrefix
 * (cleaker's namespace grammar) and namespaceToKernelPrefix's own use of
 * it: prefix is always exactly labels[0], a single label, never a
 * multi-label compound, and kernelPathFor's storage shape is always
 * either "" (root) or "users.<one label>" -- there is no second, deeper
 * prefix shape for owner(p) to disambiguate against. That's why this
 * suite (and the guard it mirrors) never needs to consult the live claims
 * ledger to answer owner(p) -- it's a pure string operation on the
 * canonical path alone.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ownerLabelOfCanonicalPath, ownerOfCanonicalPath } from "../src/kernel/manager";

const ROOT = "suis-macbook-air.local";

describe("ownerLabelOfCanonicalPath / ownerOfCanonicalPath", () => {
  it("attributes an ordinary root-level path to root itself, not to a label", () => {
    assert.equal(ownerLabelOfCanonicalPath("profile.email"), null);
    assert.equal(ownerOfCanonicalPath(ROOT, "profile.email"), ROOT);
  });

  it("attributes content under a handle's users.<label>.* branch to that label", () => {
    assert.equal(ownerLabelOfCanonicalPath("users.alice.profile.email"), "alice");
    assert.equal(ownerOfCanonicalPath(ROOT, "users.alice.profile.email"), `alice.${ROOT}`);
  });

  it("does not confuse a label with another label it is a textual prefix of (segment boundary, not text prefix)", () => {
    assert.equal(ownerLabelOfCanonicalPath("users.alice.profile.email"), "alice");
    assert.equal(ownerLabelOfCanonicalPath("users.alicex.profile.email"), "alicex");
    assert.notEqual(
      ownerOfCanonicalPath(ROOT, "users.alice.profile.email"),
      ownerOfCanonicalPath(ROOT, "users.alicex.profile.email"),
    );
    // the specific failure mode a naive `startsWith("users.alice")` (no
    // trailing-dot boundary) would produce: alicex's data would resolve
    // to the same owner as alice's.
    assert.notEqual(ownerLabelOfCanonicalPath("users.alicex.profile.email"), "alice");
  });

  it("a path that matches no users.<label> shape at all belongs to root -- explicitly, not by omission", () => {
    // Genuinely unrelated top-level branches (never a users.* shape).
    for (const p of ["", "apps.someApp.config", "netget.delegates", "keychain.jabellae"]) {
      assert.equal(ownerLabelOfCanonicalPath(p), null, `expected root for ${JSON.stringify(p)}`);
      assert.equal(ownerOfCanonicalPath(ROOT, p), ROOT, `expected root for ${JSON.stringify(p)}`);
    }
  });

  it("the bare users.<label> pointer itself (no content beneath it) still resolves to that label, not root", () => {
    // Matches isForeignUsersPrefixWrite's existing, live-verified
    // behavior unchanged -- see ownerLabelOfCanonicalPath's own comment
    // for why this is the conservative choice: the pointer is written
    // internally by the claim mechanism (records.ts), never through the
    // signed generic write surface, so nothing legitimate needs this to
    // resolve to root.
    assert.equal(ownerLabelOfCanonicalPath("users.alice"), "alice");
    assert.equal(ownerOfCanonicalPath(ROOT, "users.alice"), `alice.${ROOT}`);
  });

  it("the bare 'users' segment alone (no label at all) belongs to root", () => {
    assert.equal(ownerLabelOfCanonicalPath("users"), null);
    assert.equal(ownerOfCanonicalPath(ROOT, "users"), ROOT);
  });

  it("nested paths deep under a label's own branch still resolve to that label", () => {
    assert.equal(ownerLabelOfCanonicalPath("users.alice.a.b.c.d"), "alice");
    assert.equal(ownerOfCanonicalPath(ROOT, "users.alice.a.b.c.d"), `alice.${ROOT}`);
  });
});
