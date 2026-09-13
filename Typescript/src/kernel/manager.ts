import ME from "this.me";
import { parseNamespaceExpression } from "cleaker";
import os from "os";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
} from "fs";
import { resolve, join } from "path";
import { normalizeNamespaceRootName } from "../namespace/identity.js";

const DEFAULT_ME_STATE_DIR = resolve(process.cwd(), "me-state");

let _kernel: InstanceType<typeof ME> | null = null;

// ─── single-process-per-stateDir exclusion ───────────────────────────────
// The installation-authorization mechanism (claim/installationAuthorization.ts)
// depends on exactly one live process ever treating a given stateDir as its
// own kernel — its whole reclaim-an-"in-flight"-record design assumes an
// in-flight marker can only ever be the residue of an INTERRUPTED attempt,
// never a genuinely concurrent one. That assumption was unverified and, on
// investigation, FALSE at the point the previous check ran:
// startMonadProcess()'s own "already running" check (readMonadRecord +
// pidAlive) has a real TOCTOU race — confirmed empirically, two concurrent
// calls under the same name can both proceed. What accidentally prevented
// two live processes from coexisting was two racing calls usually landing
// on the SAME free port and one losing the OS-level bind — not a designed
// guarantee, and not one that holds with two different explicit ports.
//
// This closes it at the one place every process that actually TOUCHES a
// stateDir must go through, regardless of how it was launched (the
// `monads` CLI, netget's startNetgetMonad(), or a test's createMonadApp()
// with a hand-set ME_STATE_DIR) — getKernel(), not startMonadProcess()'s
// own launcher-side check, which only covers ITS OWN specific call path.
const STATE_DIR_LOCK_FILENAME = "process.lock";
let _lockFd: number | null = null;
let _lockPath: string | null = null;
let _lockExitHandler: (() => void) | null = null;

function isLockHolderPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

// Deliberately ONLY the 'exit' event, no SIGTERM/SIGINT handlers of our
// own. kernel/persist.ts's setupPersistence() already owns SIGTERM/SIGINT
// for the real server path (saves, then calls process.exit(0)) — Node
// invokes same-event listeners in registration order, so a second
// SIGTERM/SIGINT handler registered here that ALSO calls process.exit()
// races it and can short-circuit the save entirely if it happens to run
// first (confirmed the hard way: this exact mistake broke
// identityRootPersistence.process.test.ts's SIGTERM-save assertion the
// first time this lock was added). 'exit' fires exactly once no matter
// which path triggers it — persist.ts's own process.exit(0), a caller's,
// or the normal event-loop-drained case — so this never needs to compete
// for the same event or decide whether it's safe to terminate the process
// itself. A SIGKILL, or a SIGTERM with truly no listener anywhere, leaves
// the lock file stale on disk; that is by design, not a gap — the next
// acquireStateDirLock() call reclaims it via the pid-liveness check below,
// which is exactly the "recovery after a crash" guarantee this exists to
// provide, not merely tolerate.
function registerStateDirLockCleanup(): void {
  if (_lockExitHandler) return; // already registered for this process
  _lockExitHandler = () => releaseStateDirLock();
  process.on("exit", _lockExitHandler);
}

function unregisterStateDirLockCleanup(): void {
  if (_lockExitHandler) process.removeListener("exit", _lockExitHandler);
  _lockExitHandler = null;
}

/**
 * Acquires the exclusive lock for `stateDir`, or throws `STATE_DIR_ALREADY_IN_USE`
 * if a genuinely live process already holds it. A lock file whose recorded
 * pid is NOT alive is stale (the process that held it crashed or was
 * killed without running its own cleanup) and is reclaimed automatically —
 * recovery must never require manual intervention just because a prior
 * process died uncleanly.
 *
 * Deliberately held for the ENTIRE process lifetime, not just at startup:
 * the guarantee is "one live process may use this stateDir," not "no two
 * processes may start at the exact same instant" — a lock released right
 * after boot would let a SECOND process acquire it later while the first
 * is still running, which is exactly the scenario this exists to prevent.
 */
function acquireStateDirLock(stateDir: string): void {
  if (_lockPath === join(stateDir, STATE_DIR_LOCK_FILENAME) && _lockFd !== null) {
    return; // this exact process already holds this exact lock
  }
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, STATE_DIR_LOCK_FILENAME);

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holderPid: number | null = null;
    try {
      holderPid = Number(JSON.parse(readFileSync(lockPath, "utf8")).pid);
    } catch {
      holderPid = null; // unreadable/corrupt lock file — treat as stale below
    }
    if (holderPid && isLockHolderPidAlive(holderPid)) {
      throw new Error(
        `STATE_DIR_ALREADY_IN_USE: ${stateDir} is already in use by a live process (pid ${holderPid}). `
        + "Refusing to start a second kernel against the same state directory.",
      );
    }
    // Stale lock (holder pid recorded but dead, or the file was unreadable)
    // — safe to reclaim. If a genuine concurrent reclaimer wins this exact
    // race, the following openSync throws EEXIST again and propagates
    // uncaught rather than silently double-acquiring; that's correct — a
    // caller-visible failure here is far cheaper than a false lock.
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone — another reclaimer got there first; the openSync
      // below will succeed for whichever process reaches it first.
    }
    fd = openSync(lockPath, "wx");
  }

  writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  _lockFd = fd;
  _lockPath = lockPath;
  registerStateDirLockCleanup();
}

/** Releases this process's own stateDir lock, if it holds one. Safe to call
 *  even when no lock is held (tests reset state far more often than a real
 *  process would ever re-acquire one). */
export function releaseStateDirLock(): void {
  if (_lockFd !== null) {
    try {
      closeSync(_lockFd);
    } catch {
      // Non-fatal — the fd may already be invalid if the process is
      // already tearing down.
    }
    _lockFd = null;
  }
  if (_lockPath) {
    try {
      unlinkSync(_lockPath);
    } catch {
      // Non-fatal — already gone, or a permissions issue on the way out;
      // a lock that outlives this process is recovered by the next
      // acquirer's own stale-pid check, not by this cleanup succeeding.
    }
    _lockPath = null;
  }
  unregisterStateDirLockCleanup();
}

export function getKernelStateDir(): string {
  const configured = String(process.env.ME_STATE_DIR || "").trim();
  return configured ? resolve(configured) : DEFAULT_ME_STATE_DIR;
}

export function getKernelStatePath(...segments: string[]): string {
  return resolve(getKernelStateDir(), ...segments);
}

export function getKernel(): InstanceType<typeof ME> {
  if (_kernel) return _kernel;

  const seed = process.env.SEED || process.env.ME_SEED;
  if (!seed) throw new Error("SEED is required — set it in your environment before starting monad.ai");

  mkdirSync(getKernelStateDir(), { recursive: true });
  acquireStateDirLock(getKernelStateDir());

  _kernel = new ME(seed, {
    store: new ME.DiskStore({ baseDir: getKernelStateDir() }),
  });

  const snapshotPath = getKernelStatePath("snapshot.json");
  if (existsSync(snapshotPath)) {
    try {
      const raw = readFileSync(snapshotPath, "utf8");
      _kernel.hydrate(JSON.parse(raw));
      console.log("[kernel] hydrated from snapshot");
    } catch (e) {
      // Durability boundary (security battery, modules/monad/Typescript/tests/Security/):
      // a corrupted/truncated snapshot.json must never be silently discarded
      // in place — the very next saveSnapshot() call (e.g. on the next
      // SIGTERM) would otherwise overwrite it with this session's near-empty
      // in-memory state, permanently destroying whatever the last GOOD
      // snapshot actually held. Preserve the bad bytes on disk (best effort;
      // never throws) before falling back to an empty kernel, so the failure
      // is forensically recoverable instead of quietly compounding on the
      // next save. This does not promise recovery of unconfirmed writes —
      // only that a write that already made it to disk isn't destroyed by a
      // later save that doesn't know it was ever there.
      try {
        const quarantinePath = getKernelStatePath(`snapshot.json.corrupted-${Date.now()}`);
        renameSync(snapshotPath, quarantinePath);
        console.error(
          "[kernel] snapshot hydration failed — corrupted file preserved at",
          quarantinePath,
          "— starting fresh:",
          e,
        );
      } catch (quarantineErr) {
        console.error(
          "[kernel] snapshot hydration failed AND could not quarantine the corrupted file — starting fresh:",
          e,
          quarantineErr,
        );
      }
    }
  }

  return _kernel;
}

/**
 * Same write as saveSnapshot() below, but rethrows instead of swallowing —
 * saveSnapshot()'s own catch-and-log contract is relied on elsewhere (fire-
 * and-forget after an ordinary write), so it stays as-is for every existing
 * caller. This variant exists for callers that must actually know whether
 * the write reached disk before deciding a caller-visible outcome (e.g.
 * gatewayAuthority.ts's first-bootstrap gate, which must not finalize an
 * installation authorization as consumed on the strength of an in-memory
 * mutation alone — see installationAuthorization.ts's header comment).
 */
export function saveSnapshotOrThrow(): void {
  if (!_kernel) throw new Error("KERNEL_NOT_READY");
  const stateDir = getKernelStateDir();
  mkdirSync(stateDir, { recursive: true });
  const snapshotPath = getKernelStatePath("snapshot.json");
  const snapshot = _kernel.exportSnapshot();
  const payload = JSON.stringify(snapshot);
  // Durability boundary: write-then-rename, not an in-place write. A
  // process killed mid-write (SIGKILL, OOM, host crash) leaves the
  // canonical snapshot.json untouched — either the previous complete file
  // is still there, or the new complete file replaced it — never a
  // truncated hybrid of both. A same-directory rename is atomic at the
  // filesystem level on the platforms this runs on (POSIX rename(2); the
  // security battery's process-interruption tests verify this against a
  // real SIGKILL, not just reasoning about it).
  const tmpPath = getKernelStatePath(`.snapshot.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, payload, "utf8");
  renameSync(tmpPath, snapshotPath);
  console.log("[kernel] snapshot saved to", snapshotPath);
}

export function saveSnapshot(): void {
  try {
    saveSnapshotOrThrow();
  } catch (e) {
    console.error("[kernel] snapshot save failed:", e);
  }
}

/**
 * Reads a path from the LAST snapshot.json actually written to disk, via a
 * fresh, throwaway kernel instance hydrated straight from that file — never
 * the live in-memory `_kernel` singleton. `kernelSet`/`kernelWrite` mutate
 * the in-memory kernel immediately; saveSnapshot's own disk write can still
 * fail, or simply not have run yet. Anywhere "did this survive to durable
 * storage" must be answered precisely — not "does the in-memory object
 * currently say so" — reads through here instead of the ordinary get.
 * Returns undefined if no snapshot exists yet, or the path isn't present in
 * the one that does. Not memoized on purpose: correctness over the cost of
 * a rare, deliberately-infrequent re-read (see call sites).
 */
export function readDurableSnapshotValue(path: string): unknown {
  const snapshotPath = getKernelStatePath("snapshot.json");
  if (!existsSync(snapshotPath)) return undefined;
  const seed = process.env.SEED || process.env.ME_SEED;
  if (!seed) throw new Error("SEED is required — set it in your environment before starting monad.ai");
  const raw = readFileSync(snapshotPath, "utf8");
  // Deliberately NO `store` option here — omitting it defaults to this.me's
  // own in-memory MemoryStore (kernel-state.ts: `options.store ?? new
  // MemoryStore()`), not a DiskStore pointed at this same directory. A
  // DiskStore's own hydrate/import path writes its OWN index files to
  // `baseDir` as a side effect (confirmed the hard way: this used to throw
  // EACCES on a read-only state dir, exactly the scenario this function
  // exists to verify through) — a read-only VERIFICATION of what's already
  // on disk must never itself touch disk.
  const verifyKernel = new ME(seed);
  verifyKernel.hydrate(JSON.parse(raw));
  const reader = verifyKernel as unknown as (p: string) => unknown;
  return reader(path);
}

export function kernelReady(): boolean {
  return _kernel !== null;
}

export function getRootNamespace(): string {
  const explicit = String(
    process.env.ME_NAMESPACE ||
      process.env.MONAD_SELF_IDENTITY ||
      process.env.MONAD_SELF_HOSTNAME ||
      os.hostname() ||
      "",
  ).trim();
  return normalizeNamespaceRootName(explicit) || "unknown";
}

export function namespaceToKernelPrefix(namespace: string): string {
  let parsed: ReturnType<typeof parseNamespaceExpression>;
  try {
    parsed = parseNamespaceExpression(namespace);
  } catch {
    return "";
  }

  const root = getRootNamespace();
  const constant = normalizeNamespaceRootName(parsed.constant);
  if (constant !== root) return "";
  if (parsed.prefix) return `users.${parsed.prefix}`;

  // Root namespace — operate at kernel root.
  return "";
}

export function kernelPathFor(namespace: string, path: string): string {
  const prefix = namespaceToKernelPrefix(namespace);
  return prefix ? `${prefix}.${path}` : path;
}

/**
 * True when `namespace` resolves to kernel-ROOT storage (the "" prefix
 * from namespaceToKernelPrefix above) WITHOUT actually being this monad's
 * own configured root namespace -- i.e. the fallback branch for an
 * unparseable string or a genuinely foreign root, not the legitimate "this
 * IS the root" case.
 *
 * Why this matters: claimNamespace() (records.ts) lets anyone claim ANY
 * unclaimed bare namespace string -- first-claim-wins on the string alone,
 * with no requirement that it relate to this monad's real root at all. A
 * write-authorization gate keyed off that claim (appAuthorization.ts,
 * groupAuthorization.ts: getClaim(event.namespace)) is therefore only as
 * safe as the assumption that a DIFFERENT claimed namespace string can
 * never land in the SAME physical storage as the real root's data. That
 * assumption was false: namespaceToKernelPrefix's "" fallback collapses
 * every foreign/unparseable namespace onto the exact same kernel-root
 * location the real root itself uses. Proven exploitable end-to-end in
 * namespaceCollisionAuthorization.test.ts before this function existed --
 * an identity claiming an unrelated namespace string could authorize a
 * write under THEIR OWN claim that physically overwrote apps.<id>.* data
 * that actually belonged to the real root's owner.
 *
 * commitHandler (syncHandler.ts) calls this on every event's namespace
 * BEFORE any authorization check runs, and rejects the whole commit if any
 * event would land here without truly being the root -- closing this for
 * every namespace-gated write path at once (apps.*, groups.*, and any
 * future one), not just one call site.
 */
export function isForeignNamespaceCollapsingToRoot(namespace: string): boolean {
  const trimmed = String(namespace || "").trim();
  if (!trimmed) return false; // nothing to collapse onto anything

  let parsed: ReturnType<typeof parseNamespaceExpression>;
  try {
    parsed = parseNamespaceExpression(trimmed);
  } catch {
    // Same unparseable case namespaceToKernelPrefix treats as kernel-root
    // -- never legitimately "the root" itself.
    return true;
  }

  if (parsed.prefix) return false; // resolves to users.<prefix>, not root
  const constant = normalizeNamespaceRootName(parsed.constant);
  return !isRecognizedOwnRootConstant(constant);
}

/**
 * True when `constant` is one of the namespace strings THIS PROCESS itself
 * is explicitly bound to -- never anything a caller/request can supply.
 *
 * Two, not one: getRootNamespace() (ME_NAMESPACE-first) is the semantic
 * root callers write user data under. Separately, http/selfMapping.ts's
 * ensureSelfIdentityConfig() persists (or, on first run, generates) this
 * monad's own surface/self identity into process.env.MONAD_SELF_IDENTITY
 * at boot -- and bootstrap.ts's ensureRootSemanticBootstrap() deliberately
 * seeds ROOT_SCHEMA_SEEDS under THAT identity (config.selfNodeConfig on a
 * fresh install where no ME_NAMESPACE-matching self.json exists yet), not
 * under getRootNamespace(). That's pre-existing, intentional behavior
 * (confirmed live: it broke 5 real test files the first time this guard
 * shipped without knowing about it) -- both values are explicit,
 * server-side bindings this process set for itself during its own
 * bootstrap, never attacker-suppliable input, so both are legitimately
 * "not foreign" here. This is the "vinculación explícita" the review asked
 * for in place of a silent fallback: two concretely-named, process-owned
 * env values, not "anything that happens to collapse to root storage."
 */
export function isRecognizedOwnRootConstant(constant: string): boolean {
  if (!constant) return false;
  if (constant === getRootNamespace()) return true;
  const selfIdentity = normalizeNamespaceRootName(String(process.env.MONAD_SELF_IDENTITY || ""));
  return Boolean(selfIdentity) && constant === selfIdentity;
}

export function resetKernelStateForTests(): void {
  _kernel = null;
  releaseStateDirLock();
  rmSync(getKernelStateDir(), { recursive: true, force: true });
}
