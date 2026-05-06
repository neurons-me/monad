import type express from "express";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DisclosureStatus = "ok" | "error" | "pending";

export interface DisclosureOrigin {
  monad_id: string;
  namespace: string;
  endpoint: string;
  name?: string;
}

export interface DisclosureFrame {
  status: DisclosureStatus;
  path: string;
  origin: DisclosureOrigin;
}

// ── Env flag ──────────────────────────────────────────────────────────────────

export function isDisclosureEnabled(): boolean {
  return process.env.MONAD_DISCLOSURE_ENVELOPE === "1";
}

// ── Origin builder ────────────────────────────────────────────────────────────

export function buildDisclosureOrigin(): DisclosureOrigin {
  return {
    monad_id: process.env.MONAD_ID || "",
    namespace: process.env.MONAD_SELF_IDENTITY || process.env.ME_NAMESPACE || "unknown",
    endpoint: process.env.MONAD_SELF_ENDPOINT || "",
    name: process.env.MONAD_NAME || undefined,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDisclosureStatus(body: Record<string, unknown>): DisclosureStatus {
  if (body.ok === false || (typeof body.error === "string" && body.error)) return "error";
  if (body.pending === true) return "pending";
  return "ok";
}

function normalizePath(rawPath: string): string {
  return String(rawPath || "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, ".")
    || "_";
}

// ── Direct wrap helper (for routes that call this explicitly) ─────────────────

export function applyDisclosureFrame(
  body: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  if (!isDisclosureEnabled()) return body;
  if ("_disclosure" in body) return body; // already wrapped

  const frame: DisclosureFrame = {
    status: resolveDisclosureStatus(body),
    path: normalizePath(path),
    origin: buildDisclosureOrigin(),
  };

  return { ...body, _disclosure: frame };
}

// ── Express middleware ────────────────────────────────────────────────────────
// Intercepts res.json to inject _disclosure into every JSON response when enabled.
// Uses _disclosure as a namespaced container — fully additive, no existing fields touched.

export function createDisclosureMiddleware(): express.RequestHandler {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!isDisclosureEnabled()) return next();

    const originalJson = res.json.bind(res) as (body: unknown) => express.Response;
    (res as any).json = (body: unknown): express.Response => {
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const b = body as Record<string, unknown>;
        if (!("_disclosure" in b)) {
          b._disclosure = {
            status: resolveDisclosureStatus(b),
            path: normalizePath(req.path),
            origin: buildDisclosureOrigin(),
          } satisfies DisclosureFrame;
        }
      }
      return originalJson(body);
    };

    next();
  };
}
