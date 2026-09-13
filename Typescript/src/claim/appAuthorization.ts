import { hasScope, isAdmin, type GroupRecord } from "cleaker";
import { readSemanticBranchForNamespace } from "./memoryStore.js";
import { getClaim } from "./records.js";

// GENERAL POLICY, not a special case for apps.gui: no app under a
// namespace has a claim/bootstrap of its own. Whoever already has
// authority over the namespace (its claimed owner) has implicit, full
// authority over EVERY apps.<appId>.* branch inside it, for any appId --
// creating apps.gui.pages.home, or apps.myapp.pages.home, or any other
// app, is just an authorized write in a tree the caller already controls,
// not a second registration step. This is a deliberate departure from
// groupAuthorization.ts's model (groups.<key>.* IS independently
// claimable, first-claim-wins via canBootstrap) -- apps.<appId>.* never
// is, for any appId, full stop.
//
// The real consequence of this being general: two DIFFERENT apps can no
// longer have two DIFFERENT owners while living under the SAME namespace
// (appAuthorization.test.ts's myapp/otherapp cases prove per-app ADMIN and
// GRANT delegation still isolates cleanly across apps -- they do NOT prove
// independent per-app ownership, because there isn't any anymore). Genuine
// multi-tenant independence -- two apps that should answer to two
// different owners -- has to be modeled as two different NAMESPACES, not
// two apps sharing one. Roles still live in the tree, not in GUI:
// apps.<appId>.admins/.grants let the namespace owner delegate scoped (or
// full-admin) editing on a SPECIFIC app to other identities without
// handing over the namespace itself, and the backend enforces those on
// every write regardless of whether the caller ever opens GUI at all.
//
// apps.<appId>.owner is consequently dead: nothing reads it anymore
// (readAppRecord derives `owner` from the namespace's own claim, never
// from this branch). It stays in RESERVED_SEGMENTS and checkAppAuthorization
// rejects ANY write to it outright (not just gated behind admin status --
// see below) so it can never look like a live, settable field again.
// Pre-existing apps.<appId>.owner values written under the OLD
// (pre-this-change) model are left exactly where they are: never read,
// never migrated, never deleted by this code. They're just inert data now.
const RESERVED_SEGMENTS = new Set(["owner", "admins", "grants", "member", "created_by"]);

function appIdFromPath(path: string): string | null {
  const match = path.match(/^apps\.([a-z0-9_-]+)\./);
  return match ? match[1] : null;
}

function firstSegmentAfterAppId(path: string, appId: string): string | null {
  const prefix = `apps.${appId}.`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split(".")[0] || null;
}

/**
 * Reads an apps.<appId>.* branch (admins/grants only -- there is no
 * apps.<appId>.owner anymore) and shapes it into a GroupRecord whose
 * `owner` is the NAMESPACE's own claimed identityHash, not anything stored
 * on the app branch itself. This lets cleaker's isAdmin()/hasScope()
 * (isOwner(group,hash) === group.owner === hash) work completely unchanged:
 * the namespace owner is always the app's implicit owner/admin for free,
 * with zero separate bootstrap step.
 */
export function readAppRecord(namespace: string, appId: string): GroupRecord {
  const branch = readSemanticBranchForNamespace(namespace, `apps.${appId}`);
  const raw = (branch && typeof branch === "object" ? branch : {}) as Record<string, unknown>;

  const admins: Record<string, true> = {};
  if (raw.admins && typeof raw.admins === "object") {
    for (const [hash, value] of Object.entries(raw.admins as Record<string, unknown>)) {
      if (value === true) admins[hash] = true;
    }
  }

  const grants: Record<string, string[]> = {};
  if (raw.grants && typeof raw.grants === "object") {
    for (const [hash, value] of Object.entries(raw.grants as Record<string, unknown>)) {
      if (Array.isArray(value)) grants[hash] = value.filter((v): v is string => typeof v === "string");
    }
  }

  const namespaceClaim = getClaim(namespace);
  return { namespace: appId, owner: namespaceClaim?.identityHash ?? null, admins, grants };
}

/**
 * Requires the caller be authorized for every apps.<appId>.* path a commit
 * batch touches:
 *
 * 1. The namespace must already have a claimed owner (readAppRecord derives
 *    the app's owner from it) -- an unclaimed namespace authorizes nothing
 *    under it, for anyone.
 * 2. The namespace owner, or an explicit apps.<appId>.admin, may write
 *    anything under apps.<appId>.* -- no separate per-app claim/bootstrap
 *    step. This is the one real difference from groupAuthorization.ts's
 *    model: groups.<key>.* is independently claimable (first-claim-wins),
 *    apps.<appId>.* never is -- it inherits authority from the namespace
 *    that hosts it, the same way any other write to that namespace does.
 * 3. Anyone else needs a matching `<field>:write` grant for a non-reserved
 *    field; `admins`/`grants` (and the now-inert `owner`) stay
 *    owner/admin-only regardless of any scope grant.
 *
 * Returns a rejection reason, or null if authorized.
 */
export function checkAppAuthorization(events: unknown[], callerIdentityHash: string): string | null {
  const touched = new Map<string, { namespace: string; appId: string }>();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    const path = String(e.path || "").trim().toLowerCase();
    const appId = appIdFromPath(path);
    if (!appId) continue;
    const namespace = String(e.namespace || "").trim().toLowerCase();
    touched.set(`${namespace}::${appId}`, { namespace, appId });
  }
  if (touched.size === 0) return null;

  // apps.<appId>.owner is dead (see the top-of-file note): unconditional,
  // even for the namespace owner/an app admin, so it never again looks
  // like a live, settable field. Checked before the per-namespace loop
  // below so this rejection doesn't depend on whether the namespace or app
  // is otherwise authorized.
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    const path = String(e.path || "").trim().toLowerCase();
    const appId = appIdFromPath(path);
    if (!appId) continue;
    if (firstSegmentAfterAppId(path, appId) === "owner") {
      return `writing "${path}" is rejected -- apps.<appId>.owner no longer exists as a concept; an app's owner is always its namespace's own claimed owner`;
    }
  }

  for (const { namespace, appId } of touched.values()) {
    const app = readAppRecord(namespace, appId);

    if (app.owner === null) {
      return `namespace "${namespace}" has no owner yet -- claim the namespace itself (operation:'claim') before writing to apps.${appId}`;
    }

    if (isAdmin(app, callerIdentityHash)) continue;

    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const e = event as Record<string, unknown>;
      if (String(e.namespace || "").trim().toLowerCase() !== namespace) continue;
      const path = String(e.path || "").trim().toLowerCase();
      if (appIdFromPath(path) !== appId) continue;

      const segment = firstSegmentAfterAppId(path, appId);
      if (segment === null) {
        return `writing "${path}" requires being the namespace owner or an admin of app "${appId}"`;
      }
      if (RESERVED_SEGMENTS.has(segment)) {
        return `writing "${path}" requires being the namespace owner or an admin of app "${appId}" -- "${segment}" cannot be unlocked with a scope grant`;
      }
      if (!hasScope(app, callerIdentityHash, `${segment}:write`)) {
        return `writing "${path}" requires being the namespace owner or an admin of app "${appId}", or a member with a "${segment}:write" grant`;
      }
    }
  }
  return null;
}
