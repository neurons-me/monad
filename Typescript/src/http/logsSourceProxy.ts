/**
 * logsSourceProxy.ts
 *
 * Resolves `logs`/`logs.*` NRP reads against a real, external, ROTATING
 * log source instead of `.me`'s own memory store — see me/Typescript's
 * typedocs/Plurality-Is-Grammar.md for why: the memory log is append-only
 * (hash-chained), so copying every log line into it would grow it forever.
 * The shape (`logs[]`, cardinality, ordering) can still be DESCRIBED as a
 * normal `.me` write elsewhere; this module is only the READ side, and it
 * deliberately never writes anything back into the kernel.
 *
 * Generic on purpose — this file has no idea it's usually netget on the
 * other end. `LOG_SOURCE_URL`/`LOG_SOURCE_NAMESPACE` are whatever this
 * monad instance's OWN process.env carries at spawn time (netget's
 * netgetMonadProcess.ts sets them before starting its own monad,
 * inherited via startMonadProcess()'s `{ ...process.env, ... }` child env
 * — no monad.ai code hardcodes "netget" anywhere). Any other consumer of
 * the same monad.ai package could point this at its own log-serving HTTP
 * endpoint, under its own namespace, the same way.
 *
 * shouldInterceptLogsPath() is what makes this safe to enable at all: it
 * requires an EXACT namespace match against LOG_SOURCE_NAMESPACE (never a
 * blanket "any namespace asking for logs.*") and an exact dotPath match
 * against the finite set of real log types — see its own doc comment.
 *
 * Authorization is NOT decided here: this proxy forwards only the
 * `Authorization` header (a bearer session token, verified by the
 * source's own admin-session mechanism — see netget's adminSession.ts).
 * It deliberately does NOT forward X-Netget-Identity/X-Netget-Scopes —
 * those are only genuine when nginx's own signature verification ran
 * first, which does not hold for a request reaching this monad directly;
 * forwarding them here would let a forged header reach the source
 * exactly the same way it could forge them against the source directly.
 * The source endpoint remains the one real authority on who may read its
 * own logs; this proxy's only job is to not weaken that.
 */

export type LogsSourceResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

const FORWARDED_HEADER_NAMES = ['authorization'];

// The only real log sources that exist (localNetget.js's own /logs route
// rejects anything else with 400) — matched exactly, not by prefix, so a
// namespace that legitimately has OTHER data at "logs.something-else"
// never gets silently redirected to nginx's own logs.
const KNOWN_LOG_TYPES = new Set(['access', 'error', 'server']);

export interface MinimalLogsRequest {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
}

function isLogsDotPath(dotPath: string): boolean {
  if (dotPath === 'logs') return true;
  const segments = dotPath.split('.');
  return segments.length === 2 && segments[0] === 'logs' && KNOWN_LOG_TYPES.has(segments[1]);
}

/**
 * Only intercepts when BOTH match exactly:
 *   - `namespace` is the ONE namespace this monad was configured (via
 *     LOG_SOURCE_NAMESPACE) to serve host-level logs under — never a
 *     blanket "any namespace asking for logs.* gets the host's logs".
 *     Two different namespaces reading "logs.access" must not resolve to
 *     the same data just because neither one is the configured one.
 *   - `dotPath` is exactly "logs" or "logs.<a real type>" — never a
 *     prefix match that could also swallow some unrelated "logs.foo"
 *     path a namespace legitimately owns.
 * Returns null (never intercept) rather than an error result when either
 * check fails — the caller falls through to the normal memory-store read
 * for that path, exactly as if this module didn't exist.
 */
export function shouldInterceptLogsPath(namespace: string, dotPath: string): boolean {
  const configuredNamespace = process.env.LOG_SOURCE_NAMESPACE;
  if (!configuredNamespace) return false;
  if (namespace !== configuredNamespace) return false;
  return isLogsDotPath(dotPath);
}

/**
 * `dotPath` is `"logs"` or `"logs.<type>"` (e.g. `"logs.access"`) — the
 * type can come from either the path segment or a `?type=` query param;
 * the path segment wins when both are present. Caller must have already
 * confirmed shouldInterceptLogsPath() for this exact (namespace, dotPath)
 * pair — this function itself no longer re-checks namespace, since by
 * the time it's called that decision is already made.
 */
export async function resolveLogsFromSource(req: MinimalLogsRequest, dotPath: string): Promise<LogsSourceResult> {
  const sourceUrl = process.env.LOG_SOURCE_URL;
  if (!sourceUrl) {
    return { ok: false, status: 404, error: 'LOG_SOURCE_NOT_CONFIGURED' };
  }

  const segments = dotPath.split('.');
  const typeFromPath = segments.length > 1 ? segments[1] : undefined;
  const type = typeFromPath || String(req.query.type || 'access');
  const limit = String(req.query.limit || '50');
  const offset = String(req.query.offset || '0');

  let target: URL;
  try {
    target = new URL('/logs', sourceUrl);
  } catch {
    return { ok: false, status: 500, error: 'LOG_SOURCE_URL_INVALID' };
  }
  target.searchParams.set('type', type);
  target.searchParams.set('limit', limit);
  target.searchParams.set('offset', offset);

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADER_NAMES) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }

  try {
    const res = await fetch(target.toString(), { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: (body && body.error) || 'LOG_SOURCE_ERROR' };
    }
    return { ok: true, value: body };
  } catch {
    return { ok: false, status: 502, error: 'LOG_SOURCE_UNREACHABLE' };
  }
}
