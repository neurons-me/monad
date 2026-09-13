import { getBlocksForIdentity } from "./blockchain.js";
import { getClaim } from "../claim/records.js";
import { appendSemanticMemory, readSemanticBranchForNamespace } from "../claim/memoryStore.js";
import { getRootNamespace } from "../kernel/manager.js";
import { composeProjectedNamespace, normalizeNamespaceRootName } from "../namespace/identity.js";

export type UserRow = {
  username: string;
  identityHash: string;
  publicKey: string;
  createdAt: number;
  updatedAt: number;
};

export type ClaimUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; error: "USERNAME_TAKEN" | "USERNAME_REQUIRED" | "IDENTITY_HASH_REQUIRED" | "PUBLIC_KEY_REQUIRED" };

function normalizeUsername(raw: string) {
  return String(raw || "").trim().toLowerCase();
}

function getProjectedUsersForConfiguredRoot(): UserRow[] {
  return getUsersForRootNamespace(getRootNamespace());
}

export function getAllUsers(): UserRow[] {
  return getProjectedUsersForConfiguredRoot().sort((a, b) => a.createdAt - b.createdAt);
}

function readProjectedUsersMetadata(rootNamespace: string): Record<string, Record<string, unknown>> {
  // Scoped to the "users" branch specifically (not the whole namespace's
  // memory stream) — a namespace with heavy unrelated activity (e.g.
  // surface.usage.* telemetry, tens of thousands of entries) would
  // otherwise push real users.<name> entries out of the unscoped read's
  // 5,000-entry recency cap entirely. See getUsersForRootNamespace's own
  // identical fix below for the bug this caused: real registered users
  // (found via /users, which already reads this same branch-scoped way)
  // silently missing from this namespace-wide view.
  // readSemanticBranchForNamespace (not buildSemanticBranchTreeForNamespace
  // directly) — the latter returns the tree still rooted at the full path
  // (`{ users: { jabellae: {...} } }`), the former unwraps it down to the
  // branch itself (`{ jabellae: {...} }`), matching what GET /users returns.
  const usersBranch = readSemanticBranchForNamespace(rootNamespace, "users") as Record<string, unknown>;
  const records: Record<string, Record<string, unknown>> = {};

  if (!usersBranch || typeof usersBranch !== "object" || Array.isArray(usersBranch)) {
    return records;
  }

  for (const [username, record] of Object.entries(usersBranch)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    records[username] = record as Record<string, unknown>;
  }

  return records;
}

export function getUsersForRootNamespace(rootNamespaceInput: string): UserRow[] {
  const rootNamespace = normalizeNamespaceRootName(rootNamespaceInput);
  if (!rootNamespace) return [];

  // readProjectedUsersMetadata() already reads the "users" branch
  // specifically (see its own comment) — reusing it here as the primary
  // source of usernames too, instead of a second, separately-scoped scan.
  // Previously this function scanned the WHOLE namespace's memory stream
  // (listSemanticMemoriesByNamespace(rootNamespace), no branch prefix) for
  // rows matching `users.<name>` — capped at the same 5,000-entry recency
  // window as every other activity in that namespace. On a namespace with
  // heavy unrelated write volume (e.g. surface.usage.* telemetry — tens of
  // thousands of entries), that cap was reached entirely by non-user
  // activity, silently pushing real users.<name> entries out of the window.
  // Real registered users were still visible via the "users" semantic path
  // directly (GET /users, me://<ns>:read/users) because that read was
  // already branch-scoped — this function just wasn't using the same scope.
  const projectedMetadata = readProjectedUsersMetadata(rootNamespace);
  const seen = new Set<string>();
  const users: UserRow[] = [];

  for (const [rawUsername, record] of Object.entries(projectedMetadata)) {
    const username = normalizeUsername(rawUsername);
    if (!username || seen.has(username)) continue;
    seen.add(username);

    const ptr = record as { __ptr?: unknown } | null;
    const projectedNamespace = String(ptr?.__ptr || "").trim().toLowerCase()
      || composeProjectedNamespace(username, rootNamespace);
    const claim = projectedNamespace ? getClaim(projectedNamespace) : undefined;
    const metadata = record || {};

    users.push({
      username,
      identityHash: String(claim?.identityHash || metadata.identityHash || "").trim(),
      publicKey: String(claim?.publicKey || metadata.publicKey || "").trim(),
      createdAt: Number(claim?.createdAt || metadata.createdAt || 0),
      updatedAt: Number(claim?.updatedAt || metadata.updatedAt || 0),
    });
  }

  return users;
}

export function getUser(username: string): UserRow | undefined {
  const normalized = normalizeUsername(username);
  if (!normalized) return undefined;

  return getAllUsers().find((user) => user.username === normalized);
}

export function claimUser(
  username: string,
  identityHash: string,
  publicKey: string,
): ClaimUserResult {
  const normalizedUsername = normalizeUsername(username);
  const normalizedIdentityHash = String(identityHash || "").trim();
  const normalizedPublicKey = String(publicKey || "").trim();

  if (!normalizedUsername) return { ok: false, error: "USERNAME_REQUIRED" };
  if (!normalizedIdentityHash) return { ok: false, error: "IDENTITY_HASH_REQUIRED" };
  if (!normalizedPublicKey) return { ok: false, error: "PUBLIC_KEY_REQUIRED" };

  if (getUser(normalizedUsername)) {
    return { ok: false, error: "USERNAME_TAKEN" };
  }

  const now = Date.now();
  const rootNamespace = getRootNamespace();
  const projectedNamespace = composeProjectedNamespace(normalizedUsername, rootNamespace);
  const nextUser: UserRow = {
    username: normalizedUsername,
    identityHash: normalizedIdentityHash,
    publicKey: normalizedPublicKey,
    createdAt: now,
    updatedAt: now,
  };

  appendSemanticMemory({
    namespace: rootNamespace,
    path: `users.${normalizedUsername}`,
    operator: "__",
    data: { __ptr: projectedNamespace },
    timestamp: now,
  });
  appendSemanticMemory({
    namespace: rootNamespace,
    path: `users.${normalizedUsername}.identityHash`,
    data: normalizedIdentityHash,
    timestamp: now,
  });
  appendSemanticMemory({
    namespace: rootNamespace,
    path: `users.${normalizedUsername}.publicKey`,
    data: normalizedPublicKey,
    timestamp: now,
  });
  appendSemanticMemory({
    namespace: rootNamespace,
    path: `users.${normalizedUsername}.createdAt`,
    data: now,
    timestamp: now,
  });
  appendSemanticMemory({
    namespace: rootNamespace,
    path: `users.${normalizedUsername}.updatedAt`,
    data: now,
    timestamp: now,
  });

  return { ok: true, user: nextUser };
}

export function countBlocksForUser(identityHash: string) {
  return getBlocksForIdentity(identityHash).length;
}
