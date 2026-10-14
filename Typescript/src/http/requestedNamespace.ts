/**
 * requestedNamespace.ts -- the namespace a request ASKS for, apart from the door it came through.
 *
 * A connection carries a request; it does not decide which tree the request is about. Until now the
 * monad chose the tree from the host of the connection (X-Forwarded-Host, else Host), so a page reached
 * at jabellae.acme.test could only ever read jabellae's tree, whatever it asked for -- and an edge that
 * sets X-Forwarded-Host from the connection (nginx does) made a header useless as a selector.
 *
 * The request now names its namespace itself:
 *   - HTTP reads (GET/HEAD): `?namespace=<ns>` -- the form several routes here already use.
 *   - WebSocket `read` / `subscribe` / `unsubscribe`: the `namespace` field of the message.
 * Both are resolved here, against the spaces THIS monad serves (its own root and what lives under it),
 * exactly the way a host is: a namespace it does not serve is refused, never read from another tree.
 * Permissions are unchanged: what a path discloses is decided per path, per namespace, as before.
 *
 * X-Forwarded-Host / Host keep describing the connection; they remain the default when the request does
 * not name a namespace. Writes are not selected this way: they keep their own explicit forms
 * (`/me/<command>/<namespace>`, signed bodies) and ignore `?namespace=` here.
 */
import type express from "express";
import { resolveHostToMeUri } from "../runtime/hostResolver.js";
import { hasReservedHandleLabel } from "../namespace/identity.js";
import { resolveTransportHost } from "./namespace.js";

export type ServedNamespace =
  | { ok: true; namespace: string }
  | { ok: false; reason: "NAMESPACE_INVALID" | "NAMESPACE_NOT_SERVED" };

/** A namespace someone asked for, resolved against the spaces this monad serves. */
export function resolveServedNamespace(raw: unknown): ServedNamespace {
  if (typeof raw !== "string") return { ok: false, reason: "NAMESPACE_INVALID" };
  const value = raw.trim().toLowerCase();
  // one plain name: no path, port, scheme, credentials, list or whitespace
  if (!value || value.length > 253 || /[\s/:@,?#\\]/.test(value)) return { ok: false, reason: "NAMESPACE_INVALID" };
  const projected = resolveHostToMeUri(value);
  if (!projected.ok) return { ok: false, reason: "NAMESPACE_NOT_SERVED" };
  // www.<root> is the root's front door and api.<root> its service address: doors, not namespaces
  if (hasReservedHandleLabel(projected.namespace)) return { ok: false, reason: "NAMESPACE_NOT_SERVED" };
  return { ok: true, namespace: projected.namespace };
}

export type RequestedNamespace =
  | { present: false }
  | ({ present: true } & ServedNamespace);

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** The namespace an HTTP read names with `?namespace=`; nothing else selects, and only reads do. */
export function readRequestedNamespace(req: express.Request): RequestedNamespace {
  if (!SAFE_METHODS.has(String(req.method || "").toUpperCase())) return { present: false };
  const raw = (req.query as Record<string, unknown> | undefined)?.namespace;
  if (raw === undefined) return { present: false };
  return { present: true, ...resolveServedNamespace(raw) };
}

/**
 * For a read that NAMES its namespace: refuses (400) one this monad does not serve, and answers `true` when it did.
 * An unresolved namespace ("unknown") falls to the kernel root's storage further down; that is acceptable for a
 * request that named nothing, but a request that asked for a namespace must never be answered from another tree.
 */
export function refuseUnservedRequestedNamespace(req: express.Request, res: express.Response, describe: (error: string) => unknown): boolean {
  const requested = readRequestedNamespace(req);
  if (!requested.present || requested.ok) return false;
  res.status(400).json(describe(requested.reason));
  return true;
}

/**
 * True when the request reached this monad by a network ADDRESS (an IP literal, with no forwarded name): the monad
 * answering as itself, which is how the GUI's directory consumers and an operator's curl read it. It names no space.
 * That is a PUBLIC view: it delivers what the root already publishes and grants no privilege -- not an exception to
 * permissions (writes by address still pass the same signature and reserved-path guards, and a path's disclosure is
 * decided per path as for any other read).
 */
export function isReadByNetworkAddress(req: express.Request): boolean {
  const host = resolveTransportHost(req);
  return /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i.test(host) && !req.headers["x-forwarded-host"];
}

/**
 * For a read that arrived under a NAME this monad does not resolve to a space it serves ("unknown"): refuses it (404)
 * instead of letting the kernel map that namespace onto its own root's storage, which would answer a name nobody
 * created with the root's data. Not applied to a read by network address (see isReadByNetworkAddress), which names no
 * space and keeps the monad's own view. Answers `true` when it refused.
 */
export function refuseUnresolvedNameRead(
  req: express.Request,
  res: express.Response,
  namespace: string,
  describe: (error: string) => unknown,
): boolean {
  if (String(namespace || "").trim().toLowerCase() !== "unknown") return false;
  if (isReadByNetworkAddress(req)) return false;
  res.status(404).json(describe("PATH_NOT_FOUND"));
  return true;
}
