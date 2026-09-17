/**
 * openRestyStatusProxy.ts
 *
 * Resolves `openResty`/`openResty.<port>` NRP reads against the REAL,
 * live gateway-service status instead of `.me`'s own memory store — same
 * reasoning and same shape as logsSourceProxy.ts's own header: whether a
 * port is currently listening is a live operational fact, not something
 * ever written into the kernel and read back stale. A read here always
 * re-checks the actual listener at read time (via the source's own
 * checkPort() socket probe); it is never cached, memoized, or backed by
 * a prior kernel write.
 *
 * Generic on purpose, same as logsSourceProxy.ts: this file has no idea
 * it's usually netget on the other end. `OPENRESTY_STATUS_URL`/
 * `OPENRESTY_STATUS_NAMESPACE` are whatever this monad instance's OWN
 * process.env carries at spawn time — set alongside (and, in netget's
 * case, pointing at the exact same origin/namespace as)
 * LOG_SOURCE_URL/LOG_SOURCE_NAMESPACE in netget's own proxy.js, before
 * startNetgetMonad() spawns, inherited via startMonadProcess()'s
 * `{ ...process.env }` child env. Kept as its OWN pair rather than
 * reusing LOG_SOURCE_URL/NAMESPACE directly: this module's job (gateway
 * listening state) is unrelated to logs, even though today's one real
 * deployment happens to serve both from the same local origin.
 *
 * shouldInterceptOpenRestyPath() requires an EXACT namespace match
 * against OPENRESTY_STATUS_NAMESPACE (never a blanket "any namespace
 * asking for openResty.* gets this host's status") and an exact dotPath
 * match against "openResty" or "openResty.<port>" for a port this proxy
 * actually knows how to answer — see isOpenRestyDotPath()'s own comment.
 *
 * Disclosure: always "public" on a successful read, `value: false`
 * included -- the port genuinely not listening is real, useful
 * information (this is what makes it visible instead of just silently
 * absent), never folded into "closed"/404 the way a stealth-adjacent
 * kernel path would be. A source that can't even be asked (the local
 * backend itself unreachable) is a DIFFERENT, honestly-distinguished
 * outcome -- an error envelope, not a false value -- since "confirmed not
 * listening" and "couldn't determine" are not the same fact.
 */

export type OpenRestyStatusSourceResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

// The only ports this proxy can answer for -- openRestyService.ts's own
// getOpenRestyServiceStatus() only ever probes 80/443 (checkPort(80)/
// checkPort(443)), so those are the only two dotPath leaves with a real
// field to read. Matched exactly, not by any wider numeric-looking
// pattern, so a namespace that legitimately has other data at
// "openResty.something-else" is never silently redirected here.
const PORT_FIELD: Record<string, 'httpListening' | 'httpsListening'> = {
  '80': 'httpListening',
  '443': 'httpsListening',
};

export interface MinimalOpenRestyRequest {
  header(name: string): string | undefined;
}

function isOpenRestyDotPath(dotPath: string): boolean {
  if (dotPath === 'openResty') return true;
  const segments = dotPath.split('.');
  return segments.length === 2 && segments[0] === 'openResty' && segments[1] in PORT_FIELD;
}

/**
 * Only intercepts when BOTH match exactly:
 *   - `namespace` is the ONE namespace this monad was configured (via
 *     OPENRESTY_STATUS_NAMESPACE) to serve host-level gateway status
 *     under.
 *   - `dotPath` is exactly "openResty" or "openResty.<a real port this
 *     proxy can answer for>".
 * Returns false (never intercept) rather than an error result when
 * either check fails -- the caller falls through to the normal
 * memory-store read for that path, exactly as if this module didn't
 * exist.
 */
export function shouldInterceptOpenRestyPath(namespace: string, dotPath: string): boolean {
  const configuredNamespace = process.env.OPENRESTY_STATUS_NAMESPACE;
  if (!configuredNamespace) return false;
  if (namespace !== configuredNamespace) return false;
  return isOpenRestyDotPath(dotPath);
}

/**
 * `dotPath` is `"openResty"` (the full status object, as-is) or
 * `"openResty.<port>"` (just that port's own listening boolean). Caller
 * must have already confirmed shouldInterceptOpenRestyPath() for this
 * exact (namespace, dotPath) pair.
 */
export async function resolveOpenRestyStatusFromSource(
  req: MinimalOpenRestyRequest,
  dotPath: string,
): Promise<OpenRestyStatusSourceResult> {
  const sourceUrl = process.env.OPENRESTY_STATUS_URL;
  if (!sourceUrl) {
    return { ok: false, status: 404, error: 'OPENRESTY_STATUS_SOURCE_NOT_CONFIGURED' };
  }

  let target: URL;
  try {
    target = new URL('/openresty-status', sourceUrl);
  } catch {
    return { ok: false, status: 500, error: 'OPENRESTY_STATUS_URL_INVALID' };
  }

  const headers: Record<string, string> = {};
  const auth = req.header('authorization');
  if (auth) headers.authorization = auth;

  let body: any;
  try {
    const res = await fetch(target.toString(), { headers });
    body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: (body && body.error) || 'OPENRESTY_STATUS_SOURCE_ERROR' };
    }
  } catch {
    return { ok: false, status: 502, error: 'OPENRESTY_STATUS_SOURCE_UNREACHABLE' };
  }

  if (dotPath === 'openResty') {
    return { ok: true, value: body };
  }

  const port = dotPath.split('.')[1];
  const field = PORT_FIELD[port];
  return { ok: true, value: Boolean(body?.[field]) };
}
