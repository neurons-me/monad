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
 * monad (MONAD_MAIN_SERVER_NAME) as a starting value, and afterwards changed
 * only by the gateway owner's signature (setGatewayMainServerName).
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

export type MainServerSeedOutcome = "written" | "unchanged" | "kept" | "skipped";

/** The one place the path is written; callers are the seed below and the owner-signed change in gatewayAuthority.ts. */
export function writeMainServerName(namespace: string, name: string): void {
  appendSemanticMemory({ namespace, path: MAIN_SERVER_NAME_PATH, data: name });
}

/**
 * Initial value from whoever starts the monad. It is a starting point, not an
 * authority: it is written when the path is empty, and it may still correct
 * itself while no gateway has an owner (the installation is the only authority
 * that exists then). Once a gateway is claimed the tree wins and the operator's
 * value is ignored ("kept") -- changing it then takes the owner's signature.
 * Idempotent: the kernel keeps every write, so an unchanged value is not rewritten.
 */
export function seedMainServerName(
  namespace: string,
  name: string | null | undefined,
  opts: { gatewayClaimed: boolean },
): MainServerSeedOutcome {
  const value = normalizeMainServerName(name);
  if (!value) return "skipped";
  const current = readSemanticValueForNamespace(namespace, MAIN_SERVER_NAME_PATH);
  if (current === value) return "unchanged";
  if (current !== undefined && opts.gatewayClaimed) return "kept";
  writeMainServerName(namespace, value);
  return "written";
}
