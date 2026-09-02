import { canBootstrap, hasScope, isAdmin, type GroupRecord } from "cleaker";
import { readSemanticBranchForNamespace } from "./memoryStore.js";

// The self-attribution check in syncHandler.ts (findAttributionMismatch)
// only proves an event's created_by/member.<username> field names the
// caller -- it says nothing about whether the caller is actually allowed
// to touch this group at all. Before this module, any claimed identity
// could self-add to any groups.<key>.* namespace, and unprotected fields
// like groups.<key>.name had no gate whatsoever. This closes that gap by
// reading the group's real owner/admins/grants state and requiring
// authorization (membership + capability, not membership alone) for every
// write, using the same shared shape and rules GatewayClaimsManager
// already proves in production (cleaker's group/group.ts) -- not a
// second, divergent ruleset.

// Structural fields: only an owner/admin may ever touch these, regardless
// of any scope grant. Everything else is open app data under the group --
// a member with an explicit `<field>:write` scope (granted by an admin,
// via the reserved `grants` field above) may write it. This keeps the
// primitive from forcing every group write through an admin: a group
// can hold member-writable data (notes, RSVPs, whatever a consumer
// defines) without cleaker or monad ever having to know its shape --
// matching this stack's own rule that `.me` describes the shape,
// something else interprets it.
const RESERVED_SEGMENTS = new Set(["owner", "admins", "grants", "member", "created_by"]);

function groupKeyFromPath(path: string): string | null {
  const match = path.match(/^groups\.([a-z0-9_-]+)\./);
  return match ? match[1] : null;
}

function firstSegmentAfterKey(path: string, key: string): string | null {
  const prefix = `groups.${key}.`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split(".")[0] || null;
}

/** Reads a groups.<key>.* branch off the kernel and shapes it into a GroupRecord. */
export function readGroupRecord(namespace: string, key: string): GroupRecord | null {
  const branch = readSemanticBranchForNamespace(namespace, `groups.${key}`);
  if (!branch || typeof branch !== "object") return null;
  const raw = branch as Record<string, unknown>;

  const owner = typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : null;

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

  if (owner === null && Object.keys(admins).length === 0 && Object.keys(grants).length === 0) {
    return null;
  }
  return { namespace: key, owner, admins, grants };
}

/**
 * Requires the caller be authorized -- owner/admin, or (for a non-reserved
 * field) a member with a matching `<field>:write` scope -- for every
 * groups.<key>.* path a commit batch touches. For a group with no owner
 * yet, the same batch must explicitly claim ownership
 * (groups.<key>.owner = the caller's own identityHash), mirroring
 * GatewayClaimsManager.bootstrapOwner's explicit, first-claim-wins rule.
 * Returns a rejection reason, or null if authorized.
 *
 * ATOMICITY NOTE: two concurrent bootstrap requests for the same
 * groups.<key> cannot both win today. This isn't a lock this function
 * takes -- it's a property of the request pipeline it runs inside: every
 * step from isNamespaceWriteAuthorized() through this check through
 * appendSemanticMemory()'s kernelWrite() is synchronous, and Node's
 * single-threaded event loop can't preempt one request's handler to run
 * another mid-synchronous-execution. Verified empirically, not just
 * argued -- see commitGate.test.ts's "lets only one of two concurrent
 * bootstrap claims for the same group win". This guarantee is tied to
 * that synchronous chain: if the kernel write path (or anything between
 * the read here and the write in commitHandler) ever becomes genuinely
 * async -- multi-process, worker threads, an async storage backend, a
 * non-Node runtime -- this reasoning stops holding and an explicit
 * atomic-append / compare-and-write / transaction guard would be needed
 * at the write site. Re-run that concurrency test after any such change.
 */
export function checkGroupAuthorization(events: unknown[], callerIdentityHash: string): string | null {
  const touched = new Map<string, { namespace: string; key: string }>();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    const path = String(e.path || "").trim().toLowerCase();
    const key = groupKeyFromPath(path);
    if (!key) continue;
    const namespace = String(e.namespace || "").trim().toLowerCase();
    touched.set(`${namespace}::${key}`, { namespace, key });
  }
  if (touched.size === 0) return null;

  for (const { namespace, key } of touched.values()) {
    const group = readGroupRecord(namespace, key);

    if (canBootstrap(group)) {
      const claimsOwnershipHere = events.some((event) => {
        if (!event || typeof event !== "object") return false;
        const e = event as Record<string, unknown>;
        return (
          String(e.namespace || "").trim().toLowerCase() === namespace &&
          String(e.path || "").trim().toLowerCase() === `groups.${key}.owner` &&
          String(e.data || "").trim() === callerIdentityHash
        );
      });
      if (claimsOwnershipHere) continue;
      return `group "${key}" has no owner yet -- bootstrap it by claiming groups.${key}.owner`;
    }

    if (isAdmin(group as GroupRecord, callerIdentityHash)) continue;

    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const e = event as Record<string, unknown>;
      if (String(e.namespace || "").trim().toLowerCase() !== namespace) continue;
      const path = String(e.path || "").trim().toLowerCase();
      if (groupKeyFromPath(path) !== key) continue;

      const segment = firstSegmentAfterKey(path, key);
      if (segment === null) {
        return `writing "${path}" requires being an owner/admin of group "${key}"`;
      }
      if (RESERVED_SEGMENTS.has(segment)) {
        return `writing "${path}" requires being an owner/admin of group "${key}" -- "${segment}" cannot be unlocked with a scope grant`;
      }
      if (!hasScope(group as GroupRecord, callerIdentityHash, `${segment}:write`)) {
        return `writing "${path}" requires being an owner/admin of group "${key}", or a member with a "${segment}:write" grant`;
      }
    }
  }
  return null;
}
