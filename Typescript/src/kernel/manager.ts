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

export function saveSnapshot(): void {
  if (!_kernel) return;
  try {
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
  } catch (e) {
    console.error("[kernel] snapshot save failed:", e);
  }
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

export function resetKernelStateForTests(): void {
  _kernel = null;
  rmSync(getKernelStateDir(), { recursive: true, force: true });
}
