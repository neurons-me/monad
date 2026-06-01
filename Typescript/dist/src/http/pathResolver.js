import { readSemanticBranchForNamespace, isPathNearSecretScope } from "../claim/memoryStore.js";
import { resolveNamespace } from "./namespace.js";
import { normalizeHttpRequestToMeTarget } from "./meTarget.js";
import { createEnvelope, createErrorEnvelope } from "./envelope.js";
function normalizeDotPath(input) {
    return String(input || "")
        .trim()
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\//g, ".")
        .split(".")
        .filter(Boolean)
        .join(".");
}
export async function resolveNamespacePathValue(namespaceInput, dotPathInput) {
    const namespace = String(namespaceInput || "").trim();
    const dotPath = normalizeDotPath(dotPathInput);
    if (!dotPath) {
        return { namespace, path: dotPath, found: false, _classification: "not_found" };
    }
    const semanticResolved = readSemanticBranchForNamespace(namespace, dotPath);
    if (typeof semanticResolved !== "undefined") {
        return { namespace, path: dotPath, value: semanticResolved, found: true, _classification: "public" };
    }
    // undefined — could be stealth root, absent near secret, or genuinely absent.
    // Per NRP Section 6: if near any secret scope → closed (indistinguishable from stealth).
    const nearSecret = isPathNearSecretScope(namespace, dotPath);
    return {
        namespace,
        path: dotPath,
        found: false,
        _classification: nearSecret ? "closed" : "not_found",
    };
}
// Maps internal classification to wire disclosure content.
// "opened" requires explicit key material — not yet implemented; falls through to "closed".
function toDisclosureContent(classification) {
    if (classification === "public")
        return "public";
    return "closed";
}
export function createPathResolverHandler() {
    return async (req, res) => {
        const rawPath = String(req.path || "");
        const trimmed = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
        const target = normalizeHttpRequestToMeTarget(req);
        if (!trimmed) {
            return res.status(404).json(createErrorEnvelope(target, { error: "NOT_FOUND" }));
        }
        const namespace = resolveNamespace(req);
        const segments0 = trimmed.split("/").filter(Boolean);
        let segments = segments0;
        if (segments.length > 0 && segments[0].startsWith("@")) {
            segments = segments.slice(1);
            if (segments.length > 0 && segments0.length > 1 && segments0[1].startsWith("@")) {
                segments = segments.slice(1);
            }
        }
        const dotPath = normalizeDotPath(segments.join("/"));
        if (!dotPath) {
            return res.status(404).json(createErrorEnvelope(target, { error: "NOT_FOUND" }));
        }
        const resolved = await resolveNamespacePathValue(namespace, dotPath);
        // NRP Section 6: genuine absence (not near any secret scope) → 404
        if (resolved._classification === "not_found") {
            return res.status(404).json(createErrorEnvelope(target, {
                namespace,
                path: dotPath,
                error: "PATH_NOT_FOUND",
            }));
        }
        // stealth / closed / public → always 200; disclosure field distinguishes them on the wire
        const disclosureContent = toDisclosureContent(resolved._classification);
        return res.json(createEnvelope(target, {
            namespace: resolved.namespace,
            path: resolved.path,
            value: resolved.found ? resolved.value : null,
            disclosure: disclosureContent,
        }));
    };
}
