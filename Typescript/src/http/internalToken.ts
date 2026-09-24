/**
 * internalToken.ts -- the credential of the monad's own operator-side callers.
 *
 * Who reaches a monad over HTTP is not who is on the machine: every request that
 * comes through a reverse proxy arrives from 127.0.0.1, whatever the browser's
 * address was, so "loopback" cannot tell the gateway's own CLI from a visitor. What
 * can tell them apart is a secret only the machine's own processes can read.
 *
 * The monad makes one at start (32 random bytes, hex) and keeps it in
 * <runtime dir>/internal.token, mode 0600, next to its state directory; the same
 * OS user that runs the monad -- and so `netget`'s CLI and the gateway module in
 * the same process -- can read it, nobody on the network can. A caller shows it in
 * the `x-monad-internal-token` header. It is what authorizes the writes that the
 * anonymous surface refuses: the gateway's routing records, and the gateway's
 * mutating admin routes.
 *
 * MONAD_INTERNAL_TOKEN in the environment wins when it is set (an operator who
 * provisions secrets some other way). The process's own environment is updated to
 * the token in use, so a module mounted in this process reads it from there.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";

export const INTERNAL_TOKEN_HEADER = "x-monad-internal-token";
export const INTERNAL_TOKEN_FILE = "internal.token";

export function internalTokenPath(stateDir: string): string {
  return path.join(path.dirname(path.resolve(stateDir)), INTERNAL_TOKEN_FILE);
}

/** The token stored next to a monad's state directory, or null. Never creates one. */
export function readInternalTokenFile(stateDir: string): string | null {
  try {
    const value = fs.readFileSync(internalTokenPath(stateDir), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Uses the environment's token, else the stored one, else makes and stores one (0600). */
export function ensureInternalToken(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.MONAD_INTERNAL_TOKEN || "").trim();
  const file = internalTokenPath(stateDir);
  let token = fromEnv || readInternalTokenFile(stateDir);
  if (!token) {
    token = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "w" });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // no file when the token came from the environment
  }
  env.MONAD_INTERNAL_TOKEN = token;
  return token;
}

/** True when the request carries this process's internal token. Constant-time. */
export function isInternalRequest(req: Pick<express.Request, "headers">, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = String(env.MONAD_INTERNAL_TOKEN || "");
  const given = String(req.headers?.[INTERNAL_TOKEN_HEADER] || "");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The branch the gateway derives its routing from: domains.<key>.* (a domain's
 * record) and domainIndex.<key> (which owner holds it). Whoever can write these
 * decides where a hostname's traffic goes, so the generic write surfaces take
 * them only from an internal caller, whatever namespace they are written under.
 */
export function isGatewayRoutingRecordPath(pathInput: string): boolean {
  let p = String(pathInput || "").trim().replace(/\//g, ".").split(".").filter(Boolean).join(".");
  // A namespace's data also lives at users.<label>.* from the root (the same physical
  // place), so the branch is reserved behind any number of those prefixes too.
  while (/^users\.[^.]+\./.test(p)) p = p.replace(/^users\.[^.]+\./, "");
  return p === "domains" || p.startsWith("domains.") || p === "domainIndex" || p.startsWith("domainIndex.");
}

/**
 * surface.* is this process's own operational telemetry (hostTelemetryLedger.ts's
 * surface.host.*, usageLedger.ts's surface.usage.*) -- written on an interval/
 * per-request basis by the monad itself, never something an external caller
 * should write directly. It is also the exact prefix replay.ts's
 * getNamespaceChainHead() excludes from anti-replay head computation
 * (Surface-Identity-Claims.md §7.8): a write there never moves that excluded
 * head, so if an external, signed write to it were ever accepted, that same
 * signed body would stay valid to replay indefinitely -- the exclusion and
 * this reservation have to hold together, neither is sufficient alone.
 */
export function isSurfaceTelemetryReservedPath(pathInput: string): boolean {
  let p = String(pathInput || "").trim().replace(/\//g, ".").split(".").filter(Boolean).join(".");
  while (/^users\.[^.]+\./.test(p)) p = p.replace(/^users\.[^.]+\./, "");
  return p === "surface" || p.startsWith("surface.");
}
