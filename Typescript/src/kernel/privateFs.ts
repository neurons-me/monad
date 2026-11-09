import { chmodSync, existsSync, mkdirSync, statSync } from "fs";

// The monad's state (snapshot.json, the branch store, claims) is readable only by the user the monad runs as. On a gateway
// the nginx worker (www-data) and any other local user must not read it: it holds the directory, telemetry and claims.
// 2026-11-08: the VM's state/ was 0755 and snapshot.json 0644 (readable by www-data).
//
// A directory is made 0700 when it is created AND when it already exists (mkdir's mode does not change an existing one).
// That directory mode is also what survives a rollback: an older writer that creates its files 0644 inside it still cannot
// make them reachable, because nobody else can traverse the directory.
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Fails (throws) when the directory cannot be made 0700: a monad does not run on state other users can read. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if ((statSync(dir).mode & 0o777) !== PRIVATE_DIR_MODE) chmodSync(dir, PRIVATE_DIR_MODE);
  const now = statSync(dir).mode & 0o777;
  if (now !== PRIVATE_DIR_MODE) {
    throw new Error(`STATE_NOT_PRIVATE: ${dir} is ${now.toString(8)}, not 700; refusing to keep state there`);
  }
}

/** An existing file that group/others can read or write is narrowed to 0600 (a file left by an older writer). */
export function tightenPrivateFile(file: string): void {
  if (!existsSync(file)) return;
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, PRIVATE_FILE_MODE);
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`STATE_NOT_PRIVATE: ${file} is still readable by others`);
}
