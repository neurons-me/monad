import fs from "node:fs";
import path from "node:path";
import { getMonadRuntimeDir } from "./runtime.js";

/**
 * A monad's own environment, kept with its runtime data.
 *
 * The process manager builds a monad's environment from the shell that starts
 * it, and the registry (monad.json) keeps only the public facts of a monad
 * (port, namespace, pid). So anything a monad needs to be the SAME monad on the
 * next start -- above all its SEED, which is the authority of the namespace it
 * serves -- had to be re-supplied by whoever restarted it, and a restart from a
 * clean shell silently fell back to SEED = the namespace name, a different (and
 * guessable) identity. This file is where that is kept instead: `env.json` in
 * the monad's runtime directory, mode 0600, merged into the environment on
 * every start, resume and restart.
 *
 * What it can hold is deliberately narrow: upper-case variable names only, and
 * never the variables the process manager itself decides (port, namespace,
 * state dirs, self-config), so a stale entry cannot move a monad somewhere else.
 */
export const MONAD_ENV_FILE = "env.json";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_PATTERN = /(SEED|SECRET|KEY|TOKEN|PASSWORD|PASSPHRASE)/;

/** Decided by the process manager on every start; never taken from env.json. */
const MANAGED_KEYS = new Set([
  "PORT",
  "ME_NAMESPACE",
  "ME_STATE_DIR",
  "MONAD_CLAIM_DIR",
  "MONAD_SELF_CONFIG_PATH",
  "MONAD_SELF_IDENTITY",
  "MONAD_SELF_HOSTNAME",
  "MONAD_SELF_ENDPOINT",
  "MONAD_SELF_TAGS",
  "MONAD_NAME",
  "MONAD_SURFACE",
  "MONAD_ROOTSPACE",
]);

export function monadEnvPath(name: string): string {
  return path.join(getMonadRuntimeDir(name), MONAD_ENV_FILE);
}

export function validateMonadEnvKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Invalid variable name "${key}": use UPPER_CASE letters, digits and underscores.`);
  }
  if (MANAGED_KEYS.has(key)) {
    throw new Error(`${key} is decided by the process manager on every start and cannot be set here.`);
  }
  return key;
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_PATTERN.test(key);
}

/** The stored variables. A missing or unreadable file is an empty environment. */
export function readMonadEnv(name: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(monadEnvPath(name), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (KEY_PATTERN.test(key) && !MANAGED_KEYS.has(key) && typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merges `patch` into the stored environment (a `null` value removes the key)
 * and writes it back with mode 0600. Returns what is stored afterwards.
 */
export function writeMonadEnv(name: string, patch: Record<string, string | null>): Record<string, string> {
  const next = readMonadEnv(name);
  for (const [key, value] of Object.entries(patch)) {
    validateMonadEnvKey(key);
    if (value === null) delete next[key];
    else next[key] = String(value);
  }
  const file = monadEnvPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return next;
}

/** The stored variables with secret values hidden, for listing. */
export function describeMonadEnv(env: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.keys(env)
    .sort()
    .map((key) => ({ key, value: isSecretEnvKey(key) ? `(set, ${env[key].length} chars)` : env[key] }));
}
