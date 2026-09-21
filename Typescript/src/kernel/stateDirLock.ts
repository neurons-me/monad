import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code !== "ESRCH"; // Unknown/permission errors must fail closed.
  }
}

function busy(stateDir: string): Error {
  return new Error(`STATE_DIR_ALREADY_IN_USE: ${stateDir} has a live or unverifiable lock owner. Refusing to start a second kernel.`);
}

function holderPid(file: string, stateDir: string): number {
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(file, "utf8")).pid;
  } catch (error: any) {
    if (error.code === "ENOENT") throw error;
    throw busy(stateDir); // An empty legacy file may still be being written.
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw busy(stateDir);
  return pid;
}

function removeEmptyLock(lockPath: string): void {
  try {
    rmdirSync(lockPath);
  } catch (error: any) {
    // A successor publishes a NONEMPTY directory atomically. Never remove it.
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

/**
 * Local-filesystem, process-lifetime lock. Prepare ownership privately, then
 * atomically rename a nonempty directory into place. rename cannot replace a
 * nonempty directory, so there is no observable empty/uninitialized lock.
 *
 * Reapers remove only the dead owner's unique entry, then rmdir (never recursive
 * removal). A delayed reaper cannot unlink a successor's entry, or rmdir its
 * nonempty directory. This also makes concurrent recovery after SIGKILL safe.
 */
export function acquireProcessLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, "process.lock");
  const owner = `${process.pid}-${randomUUID()}.json`;
  const candidate = mkdtempSync(join(stateDir, ".process-lock-"));
  try {
    writeFileSync(join(candidate, owner), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    for (let attempt = 0; attempt < 32; attempt++) {
      try {
        renameSync(candidate, lockPath);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            unlinkSync(join(lockPath, owner));
            removeEmptyLock(lockPath);
          } catch {
            // Leave a stale record for recovery if cleanup fails.
          }
        };
      } catch (error: any) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
      }

      try {
        if (!lstatSync(lockPath).isDirectory()) {
          // Upgrade from the old JSON-file lock. Do not reclaim incomplete or
          // corrupt files: another old process may be between open and write.
          if (alive(holderPid(lockPath, stateDir))) throw busy(stateDir);
          try { unlinkSync(lockPath); } catch (error: any) {
            // A concurrent upgrader may already have installed a directory.
            if (!["ENOENT", "EISDIR", "EPERM"].includes(error.code)) throw error;
          }
        } else {
          const owners = readdirSync(lockPath);
          for (const entry of owners) {
            if (!/^\d+-[0-9a-f-]+\.json$/.test(entry)) throw busy(stateDir);
            if (alive(holderPid(join(lockPath, entry), stateDir))) throw busy(stateDir);
            try { unlinkSync(join(lockPath, entry)); } catch (error: any) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          removeEmptyLock(lockPath);
        }
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw busy(stateDir);
  } finally {
    // This is the private staging path, never the shared lock. A crash before
    // publication can leave this unused directory; it does not own the lock.
    rmSync(candidate, { recursive: true, force: true });
  }
}
