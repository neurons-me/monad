/**
 * mainServer.ts -- which domain is the gateway's main server, as a public
 * fact in the namespace itself.
 *
 *   netget.main.server.name = "netget.site"
 *
 * It reads like any other path: GET <namespace>/netget.main.server.name answers
 * with the domain, on every door that reaches this namespace (cleaker.me, its
 * www, netget.site). The domain is a value in the tree, not a setting in a file
 * next to it -- a domain record points at a place in the namespace, and this is
 * one such pointer.
 *
 * Reads are the ordinary public read. Writes are not the ordinary write: POST /
 * with no claim on the root namespace needs no signature, so anyone reaching
 * the monad could otherwise name the domain that administers the gateway. The
 * branch is therefore reserved on the generic write surfaces (same guard as
 * keychain.* and daemon.gateways.*) and is only ever set by whoever starts the
 * monad (MONAD_MAIN_SERVER_NAME), before it serves anything.
 */
import { appendSemanticMemory, readSemanticValueForNamespace } from "./memoryStore.js";

export const MAIN_SERVER_ROOT = "netget.main";
export const MAIN_SERVER_NAME_PATH = `${MAIN_SERVER_ROOT}.server.name`;

function normalizeDotPath(input: string): string {
  return String(input || "")
    .trim()
    .replace(/\//g, ".")
    .split(".")
    .filter(Boolean)
    .join(".");
}

/** True for the branch the generic write surfaces must refuse (it, its parent, and everything under it). */
export function isMainServerReservedPath(pathInput: string): boolean {
  const path = normalizeDotPath(pathInput);
  return path === "netget" || path === MAIN_SERVER_ROOT || path.startsWith(`${MAIN_SERVER_ROOT}.`);
}

/** "https://Netget.Site/" -> "netget.site"; anything that is not a bare host -> null. */
export function normalizeMainServerName(input: string | null | undefined): string | null {
  const host = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host) return null;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

/**
 * Declares the main server on the root namespace. Idempotent: a value that is
 * already there is left alone (the kernel keeps every write, so rewriting on
 * each start would grow the log for nothing). Returns whether it wrote.
 */
export function seedMainServerName(namespace: string, name: string | null | undefined): boolean {
  const value = normalizeMainServerName(name);
  if (!value) return false;
  if (readSemanticValueForNamespace(namespace, MAIN_SERVER_NAME_PATH) === value) return false;
  appendSemanticMemory({ namespace, path: MAIN_SERVER_NAME_PATH, data: value });
  return true;
}
