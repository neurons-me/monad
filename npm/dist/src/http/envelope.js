import { buildDisclosureOrigin, isDisclosureEnabled } from "./disclosure.js";
function isNamespaceShape(value) {
    if (!value || typeof value !== "object")
        return false;
    const maybe = value;
    return typeof maybe.me === "string" && typeof maybe.host === "string";
}
function normalizeNamespaceValue(value, host, fallbackMe) {
    if (isNamespaceShape(value))
        return value;
    const me = typeof value === "string" && value.trim() ? value.trim() : fallbackMe;
    return {
        me,
        host,
    };
}
function normalizeTarget(target) {
    const host = target.host || "unknown";
    const namespace = normalizeNamespaceValue(target.namespace, host, target.namespace);
    const path = target.path || "/";
    return {
        namespace,
        operation: target.operation,
        path,
        nrp: target.nrp,
        relation: target.relation,
    };
}
function normalizeEnvelopeBody(body, target) {
    const out = { ...body };
    if ("namespace" in out) {
        out.namespace = normalizeNamespaceValue(out.namespace, target.namespace.host, target.namespace.me);
    }
    return out;
}
function nestResponseFields(normalizedTarget, body) {
    const target = { ...normalizedTarget };
    const remaining = { ...body };
    const nestKeys = ["namespace", "path", "value"];
    for (const key of nestKeys) {
        if (key in remaining) {
            target[key] = remaining[key];
            delete remaining[key];
        }
    }
    return { target, remaining };
}
export function createEnvelope(target, body = {}) {
    const normalizedTarget = normalizeTarget(target);
    const normalizedBody = normalizeEnvelopeBody(body, normalizedTarget);
    const { target: nestedTarget, remaining } = nestResponseFields(normalizedTarget, normalizedBody);
    const base = { ok: true, target: nestedTarget, ...remaining };
    if (isDisclosureEnabled()) {
        base._disclosure = { status: "ok", path: normalizedTarget.path, origin: buildDisclosureOrigin() };
    }
    return base;
}
export function createErrorEnvelope(target, body = {}) {
    const normalizedTarget = normalizeTarget(target);
    const normalizedBody = normalizeEnvelopeBody(body, normalizedTarget);
    const { target: nestedTarget, remaining } = nestResponseFields(normalizedTarget, normalizedBody);
    const base = { ok: false, target: nestedTarget, ...remaining };
    if (isDisclosureEnabled()) {
        base._disclosure = { status: "error", path: normalizedTarget.path, origin: buildDisclosureOrigin() };
    }
    return base;
}
