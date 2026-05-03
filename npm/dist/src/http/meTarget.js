import { formatObserverRelationQuery, resolveNamespace, resolveObserverRelation, resolveTransportHost, } from "./namespace.js";
function normalizePathSegments(rawPath) {
    const trimmed = String(rawPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed)
        return "";
    const segments0 = trimmed.split("/").filter(Boolean);
    let segments = segments0;
    if (segments.length > 0 && segments[0].startsWith("@")) {
        segments = segments.slice(1);
        if (segments.length > 0 && segments0.length > 1 && segments0[1].startsWith("@")) {
            segments = segments.slice(1);
        }
    }
    return segments.join(".");
}
function inferOperation(req) {
    if (req.method === "POST" && req.path === "/claims")
        return "claim";
    if (req.method === "POST" && req.path === "/claims/signIn")
        return "open";
    if (req.method === "POST" && req.path === "/claims/open")
        return "open";
    if (req.method === "POST")
        return "write";
    return "read";
}
function inferNamespace(req) {
    const operation = inferOperation(req);
    const body = (req.body ?? {});
    const hinted = String(body.namespace || "").trim();
    if (hinted)
        return hinted;
    if (operation === "claim" || operation === "open") {
        return resolveNamespace(req);
    }
    return resolveNamespace(req);
}
export function buildMeTargetNrp(namespace, operation, path, relation) {
    const normalizedPath = path || "_";
    return `me://${namespace}:${operation}/${normalizedPath}${formatObserverRelationQuery(relation)}`;
}
export function normalizeHttpRequestToMeTarget(req) {
    const host = resolveTransportHost(req);
    const operation = inferOperation(req);
    const namespace = inferNamespace(req);
    const relation = resolveObserverRelation(req);
    const path = operation === "claim" || operation === "open"
        ? ""
        : normalizePathSegments(req.path);
    return {
        host,
        namespace,
        operation,
        path,
        nrp: buildMeTargetNrp(namespace, operation, path, relation),
        relation,
    };
}
