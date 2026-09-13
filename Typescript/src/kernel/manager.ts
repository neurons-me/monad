import ME from "this.me";
import { parseNamespaceExpression } from "cleaker";
import os from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { resolve } from "path";
import { normalizeNamespaceRootName } from "../namespace/identity.js";

const DEFAULT_ME_STATE_DIR = resolve(process.cwd(), "me-state");

let _kernel: InstanceType<typeof ME> | null = null;

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
  rmSync(getKernelStateDir(), { recursive: true, force: true });
}
