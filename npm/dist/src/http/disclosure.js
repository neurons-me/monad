// ── Env flag ──────────────────────────────────────────────────────────────────
export function isDisclosureEnabled() {
    return process.env.MONAD_DISCLOSURE_ENVELOPE === "1";
}
// ── Origin builder ────────────────────────────────────────────────────────────
export function buildDisclosureOrigin() {
    return {
        monad_id: process.env.MONAD_ID || "",
        namespace: process.env.MONAD_SELF_IDENTITY || process.env.ME_NAMESPACE || "unknown",
        endpoint: process.env.MONAD_SELF_ENDPOINT || "",
        name: process.env.MONAD_NAME || undefined,
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveDisclosureStatus(body) {
    if (body.ok === false || (typeof body.error === "string" && body.error))
        return "error";
    if (body.pending === true)
        return "pending";
    return "ok";
}
function normalizePath(rawPath) {
    return String(rawPath || "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\//g, ".")
        || "_";
}
// ── Direct wrap helper (for routes that call this explicitly) ─────────────────
export function applyDisclosureFrame(body, path) {
    if (!isDisclosureEnabled())
        return body;
    if ("_disclosure" in body)
        return body; // already wrapped
    const frame = {
        status: resolveDisclosureStatus(body),
        path: normalizePath(path),
        origin: buildDisclosureOrigin(),
    };
    return { ...body, _disclosure: frame };
}
// ── Express middleware ────────────────────────────────────────────────────────
// Intercepts res.json to inject _disclosure into every JSON response when enabled.
// Uses _disclosure as a namespaced container — fully additive, no existing fields touched.
export function createDisclosureMiddleware() {
    return (req, res, next) => {
        if (!isDisclosureEnabled())
            return next();
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (body !== null && typeof body === "object" && !Array.isArray(body)) {
                const b = body;
                if (!("_disclosure" in b)) {
                    b._disclosure = {
                        status: resolveDisclosureStatus(b),
                        path: normalizePath(req.path),
                        origin: buildDisclosureOrigin(),
                    };
                }
            }
            return originalJson(body);
        };
        next();
    };
}
