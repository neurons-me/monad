/**
 * semanticBranchReader.test.ts — Reading a Subtree of Semantic Data
 *
 * WHAT IS A SEMANTIC BRANCH?
 * The semantic memory store is a flat log of (namespace, path, value) entries.
 * For example:
 *   namespace/"gui.page.user.route"     = "/@username"
 *   namespace/"gui.page.user.component" = "CleakerUser"
 *   namespace/"gui.pagebuilder.status"  = "should-not-leak"
 *
 * `readSemanticBranchForNamespace(ns, "gui.page")` reads ALL paths starting with
 * "gui.page." and assembles them into a nested object:
 *   {
 *     user: {
 *       route: "/@username",
 *       component: "CleakerUser",
 *     }
 *   }
 *
 * THE KEY PROBLEM: PREFIX AMBIGUITY
 * "gui.page" and "gui.pagebuilder" share the prefix "gui.page".
 * A naive prefix query "gui.page*" would match BOTH, leaking "pagebuilder" data
 * into the branch result. The branch reader must match ONLY exact subtrees:
 *
 *   "gui.page.user.route"      → INCLUDED (path starts with "gui.page.")
 *   "gui.pagebuilder.status"   → EXCLUDED (path starts with "gui.pagebuilder", not "gui.page.")
 *
 * The dot separator is the key: "gui.page." (with trailing dot) is a strict subtree prefix.
 *
 * WHAT WE TEST:
 * Write three entries (two under "gui.page", one under "gui.pagebuilder"),
 * then verify:
 *   1. readSemanticBranchForNamespace("gui.page") returns only the gui.page.* data
 *   2. "gui.pagebuilder.status" is NOT in the branch result
 *   3. "gui.pagebuilder.status" IS still readable via readSemanticValueForNamespace
 *      (it wasn't lost — just correctly excluded from the branch query)
 */

import assert from "assert";
import {
  appendSemanticMemory,
  readSemanticBranchForNamespace,
  readSemanticValueForNamespace,
} from "../src/claim/memoryStore";

const NAMESPACE = "semantic-branch-reader.cleaker.me";

test("reads exact semantic branches without swallowing sibling prefixes", () => {
  const timestamp = Date.now();

  // Write three semantic memories:
  //   1. gui.page.user.route     → "/@username"
  //   2. gui.page.user.component → "CleakerUser"
  //   3. gui.pagebuilder.status  → "should-not-leak"
  //
  // Entries 1 and 2 are under the "gui.page" subtree.
  // Entry 3 looks like a sibling but is actually in a DIFFERENT subtree ("gui.pagebuilder").
  //
  // The danger: a naive implementation doing "find all paths starting with 'gui.page'"
  // would include entry 3 because "gui.pagebuilder" starts with "gui.page".
  // The correct implementation uses the trailing dot: "find paths starting with 'gui.page.'"
  // which correctly excludes "gui.pagebuilder.status".

  appendSemanticMemory({
    namespace: NAMESPACE,
    path: "gui.page.user.route",
    data: "/@username",
    timestamp,
  });
  appendSemanticMemory({
    namespace: NAMESPACE,
    path: "gui.page.user.component",
    data: "CleakerUser",
    timestamp: timestamp + 1,
  });
  appendSemanticMemory({
    namespace: NAMESPACE,
    path: "gui.pagebuilder.status",
    data: "should-not-leak", // this must NOT appear in readSemanticBranchForNamespace("gui.page")
    timestamp: timestamp + 2,
  });

  // ── readSemanticBranchForNamespace: strict subtree query ─────────────────────
  // WHAT: Query the "gui.page" subtree. Should return ONLY paths under "gui.page.":
  //   {
  //     user: {
  //       route: "/@username",
  //       component: "CleakerUser",
  //     }
  //   }
  //
  // The "gui.pagebuilder.status" entry must NOT appear here.
  // If it did, any component reading "gui.page" would accidentally see "pagebuilder"
  // data, potentially rendering wrong UI or exposing unintended data.
  assert.deepEqual(readSemanticBranchForNamespace(NAMESPACE, "gui.page"), {
    user: {
      route: "/@username",
      component: "CleakerUser",
    },
  });

  // ── readSemanticValueForNamespace: the excluded value still exists ─────────────
  // WHAT: Verify that "gui.pagebuilder.status" was NOT accidentally deleted or hidden.
  //       It should still be readable via exact path lookup.
  //
  // WHY: The branch reader must be a FILTER, not a DELETE. The data under
  //      "gui.pagebuilder" is valid and accessible — it just doesn't belong in
  //      the "gui.page" branch result. Both subtrees coexist in the same store.
  assert.equal(
    readSemanticValueForNamespace(NAMESPACE, "gui.pagebuilder.status"),
    "should-not-leak",
  );
});
