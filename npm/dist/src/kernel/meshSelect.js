import { parseSelectorGroups } from "../http/selfMapping.js";
import { findMonadByNameAsync, findMonadsForNamespaceAsync } from "./monadIndex.js";
import { computeScore, readClaimMeta } from "./scoring.js";
export const DEFAULT_STALE_MS = 300000; // 5 min
function normalizeToken(s) {
    return String(s || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}
function endpointHost(endpoint) {
    try {
        return new URL(endpoint).hostname.toLowerCase();
    }
    catch {
        return "";
    }
}
// Returns true if the entry satisfies the DNF selector (device/tag/host clauses).
// An empty or null selector always matches.
export function matchesMeshSelector(entry, selectorRaw) {
    if (!selectorRaw)
        return true;
    const groups = parseSelectorGroups(selectorRaw);
    if (groups.length === 0)
        return true;
    const tagSet = new Set([
        ...(entry.tags ?? []).map(normalizeToken),
        entry.type ? normalizeToken(entry.type) : "",
    ].filter(Boolean));
    const hostSet = new Set([normalizeToken(entry.namespace), endpointHost(entry.endpoint)].filter(Boolean));
    // DNF: any group fully satisfied → match
    return groups.some((group) => group.every((clause) => {
        if (clause.type === "device" || clause.type === "tag") {
            return clause.values.some((v) => tagSet.has(normalizeToken(v)));
        }
        if (clause.type === "host") {
            return clause.values.some((v) => hostSet.has(normalizeToken(v)) || tagSet.has(normalizeToken(v)));
        }
        return false;
    }));
}
// Priority: name-selector > highest-scored mesh claimant matching selectorConstraint > null
export async function selectMeshClaimant(opts) {
    const { monadSelector, namespace, selfEndpoint, selfMonadId, selectorConstraint = null, stalenessMs = DEFAULT_STALE_MS, now = Date.now(), extraScorers = [], } = opts;
    const normSelf = selfEndpoint.replace(/\/+$/, "");
    if (monadSelector) {
        const named = await findMonadByNameAsync(monadSelector);
        if (named?.endpoint)
            return { entry: named, reason: "name-selector" };
        return null;
    }
    const claimants = (await findMonadsForNamespaceAsync(namespace)).filter((m) => m.endpoint.replace(/\/+$/, "") !== normSelf &&
        (!selfMonadId || m.monad_id !== selfMonadId) &&
        now - m.last_seen <= stalenessMs &&
        matchesMeshSelector(m, selectorConstraint));
    if (claimants.length === 0)
        return null;
    const ctx = { namespace, requestedAt: now };
    const scored = claimants
        .map((m) => ({ m, score: computeScore(m, readClaimMeta(m.monad_id, namespace), ctx, extraScorers) }))
        .sort((a, b) => b.score - a.score);
    return { entry: scored[0].m, reason: "mesh-claim" };
}
