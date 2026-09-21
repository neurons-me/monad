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
