import parseTarget from "cleaker";
import { buildMeTargetNrp } from "../http/meTarget.js";
import { resolveObserverRelation, resolveTransportHost, } from "../http/namespace.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";
export function extractNamespaceSelector(namespace) {
    const raw = String(namespace || "").trim();
    if (!raw)
        return { base: "", selectorRaw: null };
    const match = raw.match(/^([^\[]+)(?:\[(.*)\])?$/);
    if (!match)
        return { base: raw, selectorRaw: null };
    return {
        base: String(match[1] || "").trim(),
        selectorRaw: match[2] === undefined ? null : String(match[2] || "").trim(),
    };
}
export function findSelectorValue(selectorRaw, selectorType) {
    const type = String(selectorType || "").trim().toLowerCase();
    if (!type)
        return null;
    const groups = selectorRaw.split("|").map((p) => p.trim()).filter(Boolean);
    for (const group of groups) {
        const parts = group.split(";").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
            const colon = part.indexOf(":");
            if (colon < 0)
                continue;
            const head = part.slice(0, colon).trim().toLowerCase();
            if (!head || head !== type)
                continue;
            const rest = part.slice(colon + 1).trim();
            if (!rest)
                continue;
            const value = rest.split(",")[0]?.trim();
            if (value)
                return value;
        }
    }
    return null;
}
export function normalizeWebUrl(value) {
    const raw = String(value || "").trim();
    if (!raw)
        return null;
    if (/^https?:\/\//i.test(raw))
        return raw;
    return `https://${raw.replace(/^\/+/, "")}`;
}
export function getNamespaceSelectorInfo(namespace) {
    const { base, selectorRaw } = extractNamespaceSelector(namespace);
    if (!selectorRaw)
        return { base, selectorRaw: null, webTarget: null, hasDevice: false };
    const webValue = findSelectorValue(selectorRaw, "web");
    const webTarget = webValue ? normalizeWebUrl(webValue) : null;
    const deviceValue = findSelectorValue(selectorRaw, "device");
    const hostValue = findSelectorValue(selectorRaw, "host");
    const hasDevice = !!(deviceValue || hostValue);
    return { base, selectorRaw, webTarget, hasDevice };
}
export function parseBridgeTarget(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw)
        return null;
    try {
        const parsed = parseTarget(raw.startsWith("me://") ? raw : `me://${raw}`, { allowShorthandRead: true });
        const t = parsed.__ptr?.target ?? parsed;
        const namespace = normalizeNamespaceIdentity(t.namespace?.fqdn ?? t.namespace ?? "");
        if (!namespace)
            return null;
        const selector = String(t.operation || t.intent?.selector || "read").trim() || "read";
        const pathSlash = String(t.path || "").trim().replace(/^\/+/, "");
        const pathDot = pathSlash.split("/").map((p) => p.trim()).filter(Boolean).join(".");
        const nrp = `me://${namespace}:${selector}/${pathDot || "_"}`;
        return { namespace, selector, pathSlash, pathDot, nrp };
    }
    catch {
        return null;
    }
}
export function buildBridgeTarget(resolved, requestHost, relation, rawFallback = "") {
    const namespaceMe = resolved?.namespace || "unknown";
    const nrp = resolved
        ? buildMeTargetNrp(namespaceMe, "read", resolved.pathDot || "", relation)
        : rawFallback || buildMeTargetNrp(namespaceMe, "read", "", relation);
    return {
        namespace: { me: namespaceMe, host: requestHost },
        operation: "read",
        path: resolved?.pathDot || "",
        nrp,
        relation,
    };
}
export function buildNormalizedTarget(req, namespace, operation, path) {
    const host = resolveTransportHost(req) || "unknown";
    const relation = resolveObserverRelation(req);
    return {
        host,
        namespace,
        operation,
        path,
        nrp: buildMeTargetNrp(namespace, operation, path, relation),
        relation,
    };
}
export function buildKernelCommandTarget(req, operation, path) {
    const host = resolveTransportHost(req) || "unknown";
    const normalizedPath = String(path || "").trim();
    const relation = resolveObserverRelation(req);
    return {
        host,
        namespace: "kernel",
        operation,
        path: normalizedPath || "_",
        nrp: buildMeTargetNrp("kernel", operation, normalizedPath || "_", relation),
        relation,
    };
}
