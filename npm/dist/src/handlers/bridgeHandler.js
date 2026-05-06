import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { buildMeTargetNrp } from "../http/meTarget.js";
import { resolveObserverRelation, resolveTransportHost } from "../http/namespace.js";
import { resolveSelfDispatch } from "../http/selfMapping.js";
import { selectMeshClaimant } from "../kernel/meshSelect.js";
import { recordForwardResult } from "../kernel/scoring.js";
import { buildBridgeTarget, getNamespaceSelectorInfo, parseBridgeTarget, } from "../runtime/bridge.js";
export function createBridgeHandler(config) {
    return async (req, res) => {
        const rawTarget = String(req.query?.target || "").trim();
        const decodedTarget = rawTarget ? decodeURIComponent(rawTarget) : "";
        const parsed = parseBridgeTarget(decodedTarget);
        const requestHost = resolveTransportHost(req) || config.hostname || "unknown-host";
        const relation = resolveObserverRelation(req);
        if (!parsed) {
            return res.status(400).json({
                ok: false,
                operation: "read",
                target: buildBridgeTarget(null, requestHost, relation, decodedTarget),
                error: "TARGET_REQUIRED",
            });
        }
        const bridgeTarget = buildBridgeTarget(parsed, requestHost, relation, decodedTarget);
        let selectorDispatch = null;
        let meshSelectorConstraint = null;
        if (!parsed.pathSlash) {
            return res.status(400).json({
                ok: false,
                operation: "read",
                target: bridgeTarget,
                error: "TARGET_PATH_REQUIRED",
            });
        }
        if (parsed.namespace.includes("[") || parsed.namespace.includes("]")) {
            const selectorInfo = getNamespaceSelectorInfo(parsed.namespace);
            const dispatch = resolveSelfDispatch(selectorInfo.base, selectorInfo.selectorRaw, config.selfNodeConfig);
            selectorDispatch = dispatch;
            if (dispatch.mode === "local") {
                // Self satisfies the selector — strip brackets and serve locally.
                parsed.namespace = selectorInfo.base;
            }
            else if (selectorInfo.webTarget) {
                // Selector resolves to an explicit web URL — fetch and proxy.
                const webTarget = {
                    host: requestHost,
                    namespace: parsed.namespace,
                    operation: "read",
                    path: parsed.pathDot || "",
                    nrp: buildMeTargetNrp(parsed.namespace, "read", parsed.pathDot || "", relation),
                    relation,
                };
                try {
                    const response = await fetch(selectorInfo.webTarget, { method: "GET" });
                    const contentType = String(response.headers.get("content-type") || "text/html; charset=utf-8");
                    const wantsJson = String(req.headers.accept || "").includes("application/json");
                    const bodyText = await response.text();
                    if (!wantsJson) {
                        res.setHeader("Content-Type", contentType);
                        return res.status(response.status).send(bodyText);
                    }
                    return res.status(response.status).json({
                        ...createEnvelope(webTarget, {
                            value: {
                                url: selectorInfo.webTarget,
                                status: response.status,
                                contentType,
                                body: bodyText,
                                overlay: parsed.pathDot || "",
                            },
                        }),
                        dispatch,
                    });
                }
                catch (error) {
                    return res.status(502).json({
                        ...createErrorEnvelope(webTarget, {
                            error: "WEB_FETCH_FAILED",
                            detail: error instanceof Error ? error.message : String(error),
                        }),
                        dispatch,
                    });
                }
            }
            else {
                // Phase 4: selector targets a different mesh node.
                // Strip brackets and let selectMeshClaimant filter claimants by selector tags.
                parsed.namespace = selectorInfo.base;
                meshSelectorConstraint = selectorInfo.selectorRaw;
            }
        }
        if (parsed.pathSlash.startsWith("resolve")) {
            return res.status(400).json({
                ok: false,
                operation: "read",
                target: bridgeTarget,
                error: "RESOLVE_PATH_BLOCKED",
            });
        }
        try {
            const staleMs = parseInt(process.env.MONAD_MESH_STALE_MS || "300000", 10);
            const monadSelector = String(req.query?.monad || "").trim();
            const selfMonadId = process.env.MONAD_ID || "";
            const selfEndpoint = `http://localhost:${config.port}`;
            const fetchStart = Date.now();
            const selection = await selectMeshClaimant({
                monadSelector,
                namespace: parsed.namespace,
                selfEndpoint,
                selfMonadId,
                selectorConstraint: meshSelectorConstraint,
                stalenessMs: staleMs,
                now: fetchStart,
            });
            if (!selection && meshSelectorConstraint) {
                return res.status(503).json({
                    ok: false,
                    operation: "read",
                    target: bridgeTarget,
                    dispatch: selectorDispatch,
                    error: "SELECTOR_NO_MESH_MATCH",
                    selector: meshSelectorConstraint,
                    hint: "No live mesh node satisfies the namespace selector.",
                });
            }
            const meshOrigin = selection ? selection.entry.endpoint.replace(/\/+$/, "") : null;
            const origin = meshOrigin ?? selfEndpoint;
            const resolveReason = selection?.reason ?? "self";
            console.log(`[bridge] ns=${parsed.namespace} reason=${resolveReason} origin=${origin}${selection ? ` monad_id=${selection.entry.monad_id}` : ""}`);
            const url = new URL(`/${parsed.pathSlash}`, origin);
            for (const [key, value] of Object.entries(req.query || {})) {
                if (key === "target" || key === "monad")
                    continue;
                if (Array.isArray(value)) {
                    for (const item of value)
                        url.searchParams.append(key, String(item));
                    continue;
                }
                if (typeof value !== "undefined")
                    url.searchParams.set(key, String(value));
            }
            const response = await fetch(url, {
                method: req.method,
                headers: {
                    "x-forwarded-host": parsed.namespace,
                    "x-forwarded-proto": "http",
                    host: parsed.namespace,
                    ...(req.method !== "GET" && req.headers["content-type"]
                        ? { "content-type": String(req.headers["content-type"]) }
                        : {}),
                },
                ...(req.method !== "GET" && req.body
                    ? { body: JSON.stringify(req.body) }
                    : {}),
            });
            const elapsed = Date.now() - fetchStart;
            console.log(`[bridge] ${req.method} ${url} → ${response.status} (${elapsed}ms)`);
            if (selection) {
                recordForwardResult(selection.entry.monad_id, parsed.namespace, elapsed, response.ok);
            }
            const meshMeta = selection
                ? {
                    _mesh: {
                        origin: meshOrigin,
                        monad_id: selection.entry.monad_id,
                        monad_name: selection.entry.name ?? null,
                        forwardedAt: fetchStart,
                        hops: 1,
                        reason: selection.reason,
                        ...(meshSelectorConstraint ? { selector: meshSelectorConstraint } : {}),
                    },
                }
                : {};
            const contentType = String(response.headers.get("content-type") || "");
            if (contentType.includes("application/json")) {
                const payload = await response.json();
                const patched = payload && typeof payload === "object"
                    ? { ...payload, target: bridgeTarget, ...(selectorDispatch ? { dispatch: selectorDispatch } : {}), ...meshMeta }
                    : { ok: response.ok, operation: "read", target: bridgeTarget, value: payload, ...(selectorDispatch ? { dispatch: selectorDispatch } : {}), ...meshMeta };
                return res.status(response.status).json(patched);
            }
            const text = await response.text();
            return res.status(response.status).send(text);
        }
        catch (error) {
            return res.status(500).json({
                ok: false,
                operation: "read",
                target: bridgeTarget,
                error: "BRIDGE_FETCH_FAILED",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    };
}
