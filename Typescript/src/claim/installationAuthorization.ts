/**
 * installationAuthorization.ts — closes the gap found in this session's own
 * gatewayAuthority.test.ts investigation: `bootstrapGatewayAuthority()`'s
 * only gate on a never-yet-claimed gatewayId was "does the caller hold a
 * real `.me` claim + active key somewhere under this monad's own root
 * constant" — true for ANY `<handle>.<root>`, not just whoever this
 * specific installation was actually set up for. A same-root identity with
 * her own perfectly valid claim and key could win first-bootstrap of ANY
 * gatewayId she could name, regardless of who actually ran that
 * installation's setup.
 *
 * The fix does not add a second namespace/identity registry, and does not
 * touch the keychain or E+A's grant/revoke/transfer machinery at all. It
 * reuses the ONE local-access proof this codebase already has —
 * netget's setup-code ceremony (gatewaySetupSession.ts), which already
 * proves "the caller has access to the install process" — and extends its
 * reach to the one place that could previously be reached WITHOUT it: a
 * direct HTTP call to the monad's own bootstrap endpoint. A never-yet-
 * bootstrapped gatewayId now requires a matching authorization record
 * placed here, and there is no first-write-wins fallback when one is
 * missing.
 *
 * Storage: a single JSON file inside the monad's OWN kernel state
 * directory (`getKernelStateDir()`, i.e. `ME_STATE_DIR` — the exact
 * directory `startMonadProcess()` already returns to whoever started this
 * process, as `MonadRuntimeStatus.record.stateDir`). This is deliberately
 * not a new IPC channel or network endpoint: the caller that issues an
 * authorization (netget, for the monad it itself spawned via
 * `startMonadProcess()`) already knows this exact path from that same
 * call's own return value — no env var or config needs to be threaded
 * through separately, and nothing here is reachable over any network route
 * (closing the "loopback binding is not proof of an authorized local
 * process" objection a reverse proxy could otherwise defeat).
 *
 * DURABILITY, not just atomicity: this module never marks an authorization
 * `consumed` itself — that is entirely the caller's responsibility, and
 * deliberately so. `bootstrapGatewayAuthority()` (gatewayAuthority.ts) only
 * calls `finalizeInstallationAuthorization(..., "consumed")` AFTER it has
 * independently confirmed, via `readDurableSnapshotValue()` (a fresh read
 * from the actual snapshot.json on disk, never the in-memory kernel), that
 * the resulting owner survived to disk. If that confirmation fails, the
 * caller finalizes back to "pending" instead — this file has no opinion on
 * what "durable" means for the caller's own store, only on faithfully
 * recording whichever outcome it's told actually happened.
 *
 * CONCURRENCY: the intended caller (`bootstrapGatewayAuthority`) is, and
 * must remain, a synchronous, non-async function with no `await` anywhere
 * between reading this file and finalizing it — Node's single-threaded
 * event loop then makes the whole read-check-mark-"in-flight" sequence
 * atomic with respect to every OTHER concurrent request in the SAME
 * process, without needing a separate lock file (the existing concurrent-
 * bootstrap-race test already relies on this exact property for
 * gatewayAuthority.ts's own first-write-wins check). A consequence worth
 * being explicit about: an `in-flight` record can therefore ONLY ever be
 * observed as a leftover from an INTERRUPTED (crashed) attempt — a live
 * process can never read back its own in-flight marker from outside the
 * very call that's still holding it, because nothing else runs until that
 * synchronous call returns. Reclaiming an `in-flight` record therefore
 * never guesses from elapsed time (a slow write is not a dead one); it
 * asks the caller's own durability check whether the interrupted attempt
 * actually landed.
 */

import fs from "fs";
import path from "path";

export type InstallationAuthorizationStatus = "pending" | "in-flight" | "consumed";

export interface InstallationAuthorizationRecord {
  gatewayId: string;
  namespace: string;
  identityHash: string;
  issuedAt: number;
  expiresAt: number;
  status: InstallationAuthorizationStatus;
}

export type InstallationAuthorizationError =
  | "INSTALLATION_AUTHORIZATION_REQUIRED"
  | "INSTALLATION_AUTHORIZATION_MISMATCH"
  | "INSTALLATION_AUTHORIZATION_EXPIRED"
  | "INSTALLATION_AUTHORIZATION_CONSUMED"
  | "INSTALLATION_AUTHORIZATION_ALREADY_PENDING";

export type InstallationAuthorizationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: InstallationAuthorizationError };

const FILENAME = "installation-authorizations.json";

/** The one path both sides must agree on: the issuer (netget, via the
 *  `stateDir` its own `startMonadProcess()` call already returned) and the
 *  consumer (this same monad process, via its own `getKernelStateDir()` —
 *  which IS that exact directory, passed in as `ME_STATE_DIR` at spawn
 *  time). Exported so neither side ever hand-assembles this path itself. */
export function getInstallationAuthorizationPath(stateDir: string): string {
  return path.join(stateDir, FILENAME);
}

function gatewayIdKey(gatewayId: string): string {
  return gatewayId.replace(/\./g, "__");
}

type AuthorizationFile = Record<string, InstallationAuthorizationRecord>;

function readAuthorizationFile(filePath: string): AuthorizationFile {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AuthorizationFile) : {};
  } catch {
    return {};
  }
}

function writeAuthorizationFile(filePath: string, data: AuthorizationFile): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal — matches every other local secret file in this codebase's
    // tolerance for filesystems/containers that don't support chmod.
  }
}

/**
 * Issues (or re-issues) a single-use installation authorization for a
 * never-yet-bootstrapped `gatewayId`. Refuses to silently overwrite a
 * still-live (not expired, not consumed) authorization for a DIFFERENT
 * namespace/identityHash — a second setup attempt for someone else must
 * fail loudly, not quietly retarget who gets to claim this installation.
 * An expired or already-consumed one is always safe to replace.
 */
export function issueInstallationAuthorization(input: {
  stateDir: string;
  gatewayId: string;
  namespace: string;
  identityHash: string;
  expiresAt: number;
}): InstallationAuthorizationResult<InstallationAuthorizationRecord> {
  const filePath = getInstallationAuthorizationPath(input.stateDir);
  const data = readAuthorizationFile(filePath);
  const key = gatewayIdKey(input.gatewayId);
  const existing = data[key];

  if (
    existing &&
    existing.status !== "consumed" &&
    Date.now() <= existing.expiresAt &&
    (existing.namespace !== input.namespace || existing.identityHash !== input.identityHash)
  ) {
    return { ok: false, error: "INSTALLATION_AUTHORIZATION_ALREADY_PENDING" };
  }

  const record: InstallationAuthorizationRecord = {
    gatewayId: input.gatewayId,
    namespace: input.namespace,
    identityHash: input.identityHash,
    issuedAt: Date.now(),
    expiresAt: input.expiresAt,
    status: "pending",
  };
  data[key] = record;
  writeAuthorizationFile(filePath, data);
  return { ok: true, value: record };
}

/**
 * Validates and, on success, marks `in-flight` a pending authorization
 * matching `gatewayId`/`namespace`/`identityHash` exactly. Does NOT mark it
 * `consumed` — the caller does that itself, only after independently
 * confirming durability (see this file's own header comment). Synchronous,
 * on purpose: see the concurrency note above for why that's load-bearing.
 *
 * `isDurablyBootstrapped` is a caller-supplied check ("does the canonical
 * store already durably show this exact identity as this gatewayId's
 * owner?") used only to resolve a leftover `in-flight` record found on
 * entry — which, by construction, can only be the residue of an
 * interrupted (crashed) prior attempt, never a live one. This module knows
 * nothing about what the caller's store looks like; it only asks the
 * question and acts on the answer.
 *
 * The reclaim-to-"consumed" branch (isDurablyBootstrapped() === true) is
 * defensive by construction, not reached by gatewayAuthority.ts's own
 * current wiring: bootstrapGatewayAuthority() checks its own durable
 * owner BEFORE ever calling this function, so a real durable owner already
 * short-circuits to ALREADY_BOOTSTRAPPED or an idempotent success earlier,
 * without touching this file. Kept anyway so this module stays correct on
 * its own terms for any future caller that reaches it with the durable
 * write already landed — see gatewayAuthority.test.ts's own
 * "[direct unit test] beginInstallationAuthorizationConsumption..." for how
 * it behaves when exercised directly.
 */
export function beginInstallationAuthorizationConsumption(input: {
  stateDir: string;
  gatewayId: string;
  namespace: string;
  identityHash: string;
  isDurablyBootstrapped: () => boolean;
}): InstallationAuthorizationResult<void> {
  const filePath = getInstallationAuthorizationPath(input.stateDir);
  const data = readAuthorizationFile(filePath);
  const key = gatewayIdKey(input.gatewayId);
  let record = data[key];

  if (!record) return { ok: false, error: "INSTALLATION_AUTHORIZATION_REQUIRED" };

  if (record.status === "in-flight") {
    // Never a live attempt (see header comment) -- resolve against the
    // caller's own durable truth, not elapsed time and not this record's
    // own say-so.
    record = { ...record, status: input.isDurablyBootstrapped() ? "consumed" : "pending" };
    data[key] = record;
    writeAuthorizationFile(filePath, data);
  }

  if (record.status === "consumed") return { ok: false, error: "INSTALLATION_AUTHORIZATION_CONSUMED" };
  if (Date.now() > record.expiresAt) return { ok: false, error: "INSTALLATION_AUTHORIZATION_EXPIRED" };
  if (record.namespace !== input.namespace || record.identityHash !== input.identityHash) {
    return { ok: false, error: "INSTALLATION_AUTHORIZATION_MISMATCH" };
  }

  data[key] = { ...record, status: "in-flight" };
  writeAuthorizationFile(filePath, data);
  return { ok: true, value: undefined };
}

/** Sets the final status once the caller knows, for certain, what actually
 *  happened: "consumed" once durability is confirmed, "pending" (safe to
 *  retry) if it wasn't. A no-op if the record is gone (nothing to finalize
 *  — should not happen in practice, tolerated rather than thrown on). */
export function finalizeInstallationAuthorization(
  stateDir: string,
  gatewayId: string,
  outcome: Extract<InstallationAuthorizationStatus, "consumed" | "pending">,
): void {
  const filePath = getInstallationAuthorizationPath(stateDir);
  const data = readAuthorizationFile(filePath);
  const key = gatewayIdKey(gatewayId);
  if (!data[key]) return;
  data[key] = { ...data[key], status: outcome };
  writeAuthorizationFile(filePath, data);
}

/** Read-only accessor for tests and diagnostics — never used to gate a
 *  decision (that's beginInstallationAuthorizationConsumption's job). */
export function readInstallationAuthorization(stateDir: string, gatewayId: string): InstallationAuthorizationRecord | null {
  const data = readAuthorizationFile(getInstallationAuthorizationPath(stateDir));
  return data[gatewayIdKey(gatewayId)] ?? null;
}
