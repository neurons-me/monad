/**
 * semanticBootstrap.test.ts — Seeding the Root Namespace Schema
 *
 * WHAT IS SEMANTIC BOOTSTRAP?
 * When a new monad.ai daemon starts for the first time, the root namespace is empty.
 * `ensureRootSemanticBootstrap(namespace)` populates it with a foundational schema:
 *
 *   1. Schema ROLES — what kinds of semantic data exist:
 *      schema.role.group.*       → groups of users/items
 *      schema.role.member.*      → group membership definitions
 *      schema.role.keys.*        → authentication keys and credentials
 *      schema.role.categories.*  → classification taxonomies
 *      schema.role.gui.*         → UI structure definitions
 *      schema.role.page.*        → page layout definitions
 *      schema.role.section.*     → page section definitions
 *      schema.role.slot.*        → content slot definitions
 *      schema.role.theme.*       → visual theme definitions
 *      schema.role.surface.*     → device/resource surface descriptors
 *      schema.role.usage.*       → resource usage metrics
 *      schema.role.budget.*      → resource budget constraints
 *      schema.role.pressure.*    → resource pressure/stress indicators
 *
 *   2. Schema FIELDS — the specific fields within each role:
 *      schema.field.gui.component.type = "string"
 *      schema.field.surface.resource.cpu.unit = "cores"
 *      etc.
 *
 *   3. GUI structure — the default UI layout:
 *      gui.theme.catalog.default = "mdrn.church"
 *      gui.page.user.component   = "CleakerUser"
 *      gui.page.user.sections    = ["profile", "relations", "hosts"]
 *      gui.left.nav.chain.route  = "/chain"
 *      etc.
 *
 * WHY IDEMPOTENT?
 * `ensureRootSemanticBootstrap` is safe to call multiple times:
 *   - First call: seeds everything → returns the number of records inserted (≥ 100)
 *   - Second call: nothing new to add → returns 0 (no duplicates)
 *
 * WHAT WE TEST:
 *   1. First call seeds ≥ 100 records
 *   2. Second call inserts 0 records (idempotent)
 *   3. Specific schema role entries exist with correct values
 *   4. GUI structure entries exist with correct values
 *   5. A non-seeded path (groups.dev-team) returns undefined (no spurious data)
 */

import assert from "assert";
import { ensureRootSemanticBootstrap } from "../src/claim/semanticBootstrap";
import {
  listSemanticMemoriesByNamespace,
  readSemanticBranchForNamespace,
  readSemanticValueForNamespace,
} from "../src/claim/memoryStore";
import { normalizeNamespaceRootName } from "../src/namespace/identity";

// Use a dedicated test namespace so bootstrap data doesn't pollute other tests
const ROOT_NAMESPACE = "semantic-bootstrap.cleaker.me";
const CANONICAL_ROOT = normalizeNamespaceRootName(ROOT_NAMESPACE);

test("seeds only root schema roles into semantic memories", () => {
  // ── First call: seeds all root schema entries ────────────────────────────────
  // WHAT: Call ensureRootSemanticBootstrap for the first time.
  //       It should seed the full schema: roles, fields, GUI structure.
  //       Expected: ≥ 100 records inserted (the actual count depends on the schema version).
  //
  // WHY: If fewer than 100 records are inserted, something is missing from the schema.
  //      The UI would render with missing components, missing navigation, or undefined types.
  const inserted = ensureRootSemanticBootstrap(ROOT_NAMESPACE);
  assert.ok(inserted >= 100, "expected semantic bootstrap to seed root schema + gui lexicon");

  // ── Second call: idempotent, no duplicates ────────────────────────────────────
  // WHAT: Call again. It should detect existing entries and skip them all → returns 0.
  //
  // WHY: Idempotency prevents duplicate entries in the memory store.
  //      If bootstrap could run multiple times and each run added records,
  //      the store would grow unboundedly and duplicate paths would cause
  //      inconsistent reads (which of the two "profile.name" entries wins?).
  const secondInsert = ensureRootSemanticBootstrap(ROOT_NAMESPACE);
  assert.equal(secondInsert, 0, "semantic bootstrap should not duplicate identical memories");

  // ── Schema roles: status fields exist for every role ─────────────────────────
  // WHAT: List all memories under schema.role.* and verify that each expected
  //       role has a `status` entry (the standard field that every role must have).
  //
  // WHY: The status field tells the schema processor whether a role is "active",
  //      "deprecated", or "draft". If status is missing, the role is ignored by
  //      any code that iterates schema roles. Every bootstrapped role must have it.
  const rows = listSemanticMemoriesByNamespace(CANONICAL_ROOT, { prefix: "schema.role.", limit: 100 });
  assert.ok(rows.some((row) => row.path === "schema.role.group.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.member.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.keys.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.categories.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.gui.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.page.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.section.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.slot.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.theme.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.surface.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.usage.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.budget.status"));
  assert.ok(rows.some((row) => row.path === "schema.role.pressure.status"));

  // ── Schema role behaviors: group and keys are "entity" type ─────────────────
  // WHAT: Role behavior.type defines how the schema engine processes this role.
  //       "entity" means each instance is a distinct object with its own identity.
  //
  // WHY: The UI generator uses this to decide whether to render a list (array) or
  //      a card (entity). Wrong type → wrong UI component → broken layout.
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.group.behavior.type"),
    "entity",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.keys.behavior.type"),
    "entity",
  );

  // ── Schema role suggests: what fields each role expects ──────────────────────
  // WHAT: Role suggest.contains is the list of expected fields within this role.
  //       The UI form builder uses this to render the right input fields.
  //
  // Examples:
  //   member role suggests: ["identity", "permissions", "joined_at"]
  //     → a form with identity (who), permissions (what they can do), joined_at (when)
  //   surface role suggests: ["resource", "usage", "policy", "budget", "pressure"]
  //     → a surface has resource capacity, usage metrics, policies, budgets, pressure levels
  assert.deepEqual(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.member.suggest.contains"),
    ["identity", "permissions", "joined_at"],
  );
  assert.deepEqual(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.surface.suggest.contains"),
    ["resource", "usage", "policy", "budget", "pressure"],
  );
  assert.deepEqual(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.categories.suggest.contains"),
    ["label", "description", "kind", "order"],
  );
  assert.deepEqual(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.role.gui.suggest.contains"),
    ["theme", "left", "right", "top", "footer", "page", "section"],
  );

  // ── Schema field types ────────────────────────────────────────────────────────
  // WHAT: Individual field type declarations within roles.
  //   schema.field.gui.component.type = "string"
  //     → the "component" field in a GUI role is a string (component name like "CleakerUser")
  //   schema.field.surface.usage.cpu.unit = "ratio"
  //     → CPU usage is measured as a ratio (0.0 to 1.0, not percentage)
  //   schema.field.surface.resource.cpu.unit = "cores"
  //     → CPU capacity is measured in cores (not ratio)
  //   schema.field.surface.budget.gui.blockchain.rows.unit = "rows"
  //     → blockchain storage budget is measured in rows
  //   schema.field.surface.pressure.cpu.unit = "ratio"
  //     → CPU pressure (stress) is also a ratio
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.field.gui.component.type"),
    "string",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.field.surface.usage.cpu.unit"),
    "ratio",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.field.surface.resource.cpu.unit"),
    "cores",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.field.surface.budget.gui.blockchain.rows.unit"),
    "rows",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "schema.field.surface.pressure.cpu.unit"),
    "ratio",
  );

  // ── GUI structure ─────────────────────────────────────────────────────────────
  // WHAT: The bootstrapped GUI structure defines the default layout of the UI.
  //   gui.theme.catalog.default = "mdrn.church"
  //     → the default visual theme is "mdrn.church"
  //   gui.page.user.component = "CleakerUser"
  //     → the user profile page uses the "CleakerUser" React component
  //   gui.page.user.sections = ["profile", "relations", "hosts"]
  //     → the user page has three tabs/sections
  //   gui.left.nav.chain.route = "/chain"
  //     → the left navigation includes a "chain" link going to /chain
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "gui.theme.catalog.default"),
    "mdrn.church",
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "gui.page.user.component"),
    "CleakerUser",
  );
  assert.deepEqual(
    readSemanticValueForNamespace(CANONICAL_ROOT, "gui.page.user.sections"),
    ["profile", "relations", "hosts"],
  );
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "gui.left.nav.chain.route"),
    "/chain",
  );

  // ── readSemanticBranchForNamespace: read all fields under a path as an object ─
  // WHAT: readSemanticBranchForNamespace(ns, "gui.page.user") returns ALL fields
  //       under gui.page.user.* as a nested object.
  //
  // Expected: {
  //   role: "page",
  //   route: "/@username",
  //   title: "User",
  //   component: "CleakerUser",
  //   sections: ["profile", "relations", "hosts"],
  // }
  //
  // WHY: The UI page renderer reads the branch as a whole object (not field by field)
  //      to get the complete page configuration in one call.
  //      If branch reading is broken, page rendering would require 5+ individual calls.
  assert.deepEqual(
    readSemanticBranchForNamespace(CANONICAL_ROOT, "gui.page.user"),
    {
      role: "page",
      route: "/@username",
      title: "User",
      component: "CleakerUser",
      sections: ["profile", "relations", "hosts"],
    },
  );

  // ── Non-existent path returns undefined ───────────────────────────────────────
  // WHAT: "groups.dev-team" was never seeded by the bootstrap.
  //       Reading it should return undefined, not an empty object or a default value.
  //
  // WHY: If the bootstrap accidentally writes to paths it shouldn't, or if the
  //      reader returns stale data, non-existent paths would have spurious values.
  //      This verifies the bootstrap is scoped correctly (only seeds what it should).
  assert.equal(
    readSemanticValueForNamespace(CANONICAL_ROOT, "groups.dev-team"),
    undefined,
  );
});
