import type express from "express";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import type { DisclosureContent } from "../http/disclosure.js";
import { buildMeTargetNrp } from "../http/meTarget.js";
import { resolveObserverRelation, resolveTransportHost } from "../http/namespace.js";
import { resolveSelfDispatch, type SelfNodeConfig } from "../http/selfMapping.js";
import {
  correlateOutcome,
  correlateSynthesisOutcome,
  recordDecision,
  recordSynthesisDecision,
} from "../kernel/decisionLog.js";
import { selectMeshClaimant, selectMeshClaimantByScope } from "../kernel/meshSelect.js";
import { selectMeshClaimants, type ScoredCandidate } from "../kernel/meshSelectMulti.js";
import { recordForwardResult } from "../kernel/scoring.js";
import type { ScorerBreakdown } from "../kernel/scoring.js";
import {
  getDefaultSynthesisPolicy,
  synthesize,
  type SynthesisPolicy,
  type SynthesisResult,
  type SynthesisSource,
} from "../kernel/synthesis.js";
import {
  buildBridgeTarget,
  getNamespaceSelectorInfo,
  parseBridgeTarget,
} from "../runtime/bridge.js";

export type BridgeHandlerConfig = {
  hostname: string;
  port: string | number;
  selfNodeConfig: SelfNodeConfig | null;
};

type ForwardResult = SynthesisSource & {
  status: number;
  contentType: string;
  payload: unknown;
};

function synthesisEnabled(): boolean {
  return process.env.MONAD_SYNTHESIS_ENABLED === "1";
}

function buildForwardUrl(
  origin: string,
  forwardPath: string,
  query: express.Request["query"],
): URL {
  const url = new URL(`/${forwardPath}`, origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (key === "target" || key === "monad") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    if (typeof value !== "undefined") url.searchParams.set(key, String(value));
  }
  return url;
}

function buildForwardInit(
  req: express.Request,
  namespace: string,
  signal?: AbortSignal,
): RequestInit {
  return {
    method: req.method,
    headers: {
      "x-forwarded-host": namespace,
      "x-forwarded-proto": "http",
      host: namespace,
      ...(req.method !== "GET" && req.headers["content-type"]
        ? { "content-type": String(req.headers["content-type"]) }
        : {}),
    },
    ...(req.method !== "GET" && req.body
      ? { body: JSON.stringify(req.body) }
      : {}),
    ...(signal ? { signal } : {}),
  };
}

// Envelope-aware: createEnvelope() (http/envelope.ts) nests `value` under
// `target.value` (nestKeys = ["namespace", "path", "value"]) for real NRP
// responses (e.g. pathResolver.ts). Older/simpler mocks may still put `value`
// at the top level, so that's checked first for backward compatibility.
// Falls back to the raw payload only when neither shape matches.
function extractPayloadValue(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if ("value" in record) return record.value;
  const target = record.target;
  if (target && typeof target === "object" && "value" in (target as Record<string, unknown>)) {
    return (target as Record<string, unknown>).value;
  }
  return payload;
}

const DISCLOSURE_VALUES = new Set(["public", "opened", "closed", "contested"]);

function coerceDisclosure(raw: unknown): DisclosureContent | null {
  if (typeof raw === "string" && DISCLOSURE_VALUES.has(raw)) {
    return raw as DisclosureContent;
  }
  if (raw && typeof raw === "object") {
    const nested = raw as Record<string, unknown>;
    return coerceDisclosure(nested.level ?? nested.status ?? nested.kind);
  }
  return null;
}

// Reads the NRP disclosure this source reported for itself (top-level
// `payload.disclosure` — createEnvelope() does not nest it, unlike `value`).
// Falls back to inferring from response success when the field is absent
// (e.g. a non-NRP endpoint): ok → assume "public", otherwise "closed" — the
// conservative default, so a malformed/failed response can never be silently
// treated as agreeing with real public values.
function extractPayloadDisclosure(payload: unknown, fallbackOk: boolean): DisclosureContent {
  if (payload && typeof payload === "object") {
    const found = coerceDisclosure((payload as Record<string, unknown>).disclosure);
    if (found) return found;
  }
  return fallbackOk ? "public" : "closed";
}

function safeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function forwardCandidate(
  candidate: ScoredCandidate,
  req: express.Request,
  namespace: string,
  forwardPath: string,
): Promise<ForwardResult> {
  const origin = candidate.entry.endpoint.replace(/\/+$/, "");
  const url = buildForwardUrl(origin, forwardPath, req.query);
  const timeoutMs = Math.max(1, safeNumber(process.env.MONAD_SYNTHESIS_TIMEOUT_MS, 5_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, buildForwardInit(req, namespace, controller.signal));
    const latencyMs = Date.now() - startedAt;
    const contentType = String(response.headers.get("content-type") || "");
    let payload: unknown;
    if (contentType.includes("application/json")) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }
    const payloadOk =
      !payload ||
      typeof payload !== "object" ||
      !("ok" in payload) ||
      (payload as Record<string, unknown>).ok !== false;
    const sourceOk = response.ok && payloadOk;

    return {
      monad_id: candidate.entry.monad_id,
      monad_name: candidate.entry.name ?? null,
      endpoint: origin,
      score: candidate.score,
      breakdown: candidate.breakdown,
      value: sourceOk ? extractPayloadValue(payload) : null,
      ok: sourceOk,
      disclosure: extractPayloadDisclosure(payload, sourceOk),
      latencyMs,
      status: response.status,
      contentType,
      payload,
    };
  } catch (error) {
    return {
      monad_id: candidate.entry.monad_id,
      monad_name: candidate.entry.name ?? null,
      endpoint: origin,
      score: candidate.score,
      breakdown: candidate.breakdown,
      value: null,
      ok: false,
      disclosure: "closed",
      latencyMs: Date.now() - startedAt,
      status: 0,
      contentType: "",
      payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function chooseSynthesisSource(
  result: SynthesisResult,
  policy: SynthesisPolicy,
): SynthesisSource | null {
  const scored = [...result.sources].sort((a, b) => {
    const d = b.score - a.score;
    return d !== 0 ? d : a.monad_id.localeCompare(b.monad_id);
  });

  if (result.disclosure === "public" || result.disclosure === "opened") {
    const match = scored.find((s) => s.ok && policy.valuesAgree(s.value, result.value));
    if (match) return match;
  }

  return scored.find((s) => s.ok) ?? scored[0] ?? null;
}

function aggregateBreakdown(candidates: ScoredCandidate[]): Record<string, ScorerBreakdown> {
  const buckets = new Map<string, { count: number; value: number; weight: number; contribution: number }>();

  for (const candidate of candidates) {
    for (const [name, part] of Object.entries(candidate.breakdown.breakdown)) {
      const bucket = buckets.get(name) ?? { count: 0, value: 0, weight: 0, contribution: 0 };
      bucket.count += 1;
      bucket.value += part.value;
      bucket.weight += part.weight;
      bucket.contribution += part.contribution;
      buckets.set(name, bucket);
    }
  }

  const out: Record<string, ScorerBreakdown> = {};
  for (const [name, bucket] of buckets) {
    out[name] = {
      value: bucket.value / bucket.count,
      weight: bucket.weight / bucket.count,
      contribution: bucket.contribution / bucket.count,
    };
  }
  return out;
}

function publicSynthesisSource(source: SynthesisSource) {
  return {
    monad_id: source.monad_id,
    monad_name: source.monad_name ?? null,
    endpoint: source.endpoint,
    score: source.score,
    ok: source.ok,
    latencyMs: source.latencyMs,
    value: source.value,
    disclosure: source.disclosure,
  };
}

export function createBridgeHandler(config: BridgeHandlerConfig): express.RequestHandler {
  return async (req, res) => {
    const rawTarget = String((req.query as any)?.target || "").trim();
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
    let selectorDispatch: ReturnType<typeof resolveSelfDispatch> | null = null;
    let meshSelectorConstraint: string | null = null;

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
      } else if (selectorInfo.webTarget) {
        // Selector resolves to an explicit web URL — fetch and proxy.
        const webTarget = {
          host: requestHost,
          namespace: parsed.namespace,
          operation: "read" as const,
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
        } catch (error) {
          return res.status(502).json({
            ...createErrorEnvelope(webTarget, {
              error: "WEB_FETCH_FAILED",
              detail: error instanceof Error ? error.message : String(error),
            }),
            dispatch,
          });
        }
      } else {
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
      const monadSelector = String((req.query as any)?.monad || "").trim();
      const selfMonadId = process.env.MONAD_ID || "";
      const selfEndpoint = `http://localhost:${config.port}`;
      const explorationRate = parseFloat(process.env.MONAD_EXPLORATION_RATE ?? "0");
      const fetchStart = Date.now();
      // When routing via monad[frank], forward to the remaining path only (strip monad[frank]/ prefix).
      const forwardPath = parsed.monadId ? (parsed.monadScopePath ?? "") : parsed.pathSlash;

      const synthesisPolicy = getDefaultSynthesisPolicy();
      const canSynthesize =
        synthesisEnabled() &&
        synthesisPolicy.maxCandidates > 1 &&
        !parsed.monadId &&
        !monadSelector;

      if (canSynthesize) {
        const multiSelection = await selectMeshClaimants({
          namespace: parsed.namespace,
          selfEndpoint,
          selfMonadId,
          selectorConstraint: meshSelectorConstraint,
          stalenessMs: staleMs,
          now: fetchStart,
          maxCandidates: synthesisPolicy.maxCandidates,
          minRelativeScore: synthesisPolicy.minRelativeScore,
        });

        if (multiSelection.candidates.length === 0 && meshSelectorConstraint) {
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

        if (multiSelection.candidates.length > 1) {
          const sources = await Promise.all(
            multiSelection.candidates.map((candidate) =>
              forwardCandidate(candidate, req, parsed.namespace, forwardPath),
            ),
          );
          const synthesis = synthesize(sources, synthesisPolicy);
          const elapsed = Date.now() - fetchStart;
          const selectedSource = chooseSynthesisSource(synthesis, synthesisPolicy);
          const selectionMargin =
            multiSelection.candidates.length > 1
              ? multiSelection.candidates[0]!.score - multiSelection.candidates[1]!.score
              : 1;

          for (const source of sources) {
            recordForwardResult(source.monad_id, parsed.namespace, source.latencyMs, source.ok);
          }

          const responseOk = synthesis.disclosure !== "closed";
          const decisionId = `${fetchStart}:synthesis:${parsed.namespace}:${Math.random().toString(36).slice(2)}`;
          recordSynthesisDecision({
            decisionId,
            timestamp: fetchStart,
            namespace: parsed.namespace,
            monadId: synthesis.divergence.strategy === "contested"
              ? "synthesis"
              : (selectedSource?.monad_id ?? "synthesis"),
            score: selectedSource?.score ?? multiSelection.candidates[0]?.score ?? 0,
            margin: selectionMargin,
            breakdown: aggregateBreakdown(multiSelection.candidates),
            ...(multiSelection.candidates[1]
              ? {
                  runnerUp: {
                    monad_id: multiSelection.candidates[1].entry.monad_id,
                    score: multiSelection.candidates[1].score,
                  },
                }
              : {}),
            synthesisPolicy: synthesis.policy,
            sourceCount: sources.length,
            agreeCount: synthesis.quorum.agreeCount,
            divergenceStrategy: synthesis.divergence.strategy,
            sourceSummaries: sources.map((source) => ({
              monad_id: source.monad_id,
              ok: source.ok,
              latencyMs: source.latencyMs,
              score: source.score,
            })),
          });
          correlateSynthesisOutcome(decisionId, elapsed, responseOk);

          const meshOrigin = selectedSource?.endpoint ?? null;
          const status = synthesis.disclosure === "closed" ? 502 : 200;
          const meshMeta = selectedSource
            ? {
                _mesh: {
                  origin: meshOrigin,
                  monad_id: selectedSource.monad_id,
                  monad_name: selectedSource.monad_name ?? null,
                  score: selectedSource.score,
                  forwardedAt: fetchStart,
                  hops: 1,
                  reason: "synthesis",
                  ...(meshSelectorConstraint ? { selector: meshSelectorConstraint } : {}),
                },
              }
            : {};

          console.log(
            `[bridge] ns=${parsed.namespace} reason=synthesis candidates=${sources.length} disclosure=${synthesis.disclosure} elapsed=${elapsed}ms`,
          );

          return res.status(status).json({
            ok: responseOk,
            operation: "read",
            target: bridgeTarget,
            disclosure: synthesis.disclosure,
            value: synthesis.value,
            ...(selectorDispatch ? { dispatch: selectorDispatch } : {}),
            ...meshMeta,
            _synthesis: {
              sources: synthesis.sources.map(publicSynthesisSource),
              quorum: synthesis.quorum,
              divergence: synthesis.divergence,
              policy: synthesis.policy,
              synthesizedAt: synthesis.synthesizedAt,
            },
          });
        }
      }

      // monad[frank] path syntax: scope-chain lookup (frank @ compound → rootspace → 404).
      const selection = parsed.monadId
        ? await selectMeshClaimantByScope({
            monadId: parsed.monadId,
            namespace: parsed.namespace,
            selfEndpoint,
            selfMonadId,
            stalenessMs: staleMs,
            now: fetchStart,
          })
        : await selectMeshClaimant({
            monadSelector,
            namespace: parsed.namespace,
            selfEndpoint,
            selfMonadId,
            selectorConstraint: meshSelectorConstraint,
            stalenessMs: staleMs,
            now: fetchStart,
            explorationRate,
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

      console.log(`[bridge] ns=${parsed.namespace} reason=${resolveReason} origin=${origin}${selection ? ` monad_id=${selection.entry.monad_id} score=${selection.score?.toFixed(3)}` : ""}`);

      // margin < 1 means runner-up exists; margin = 1 is sentinel for "sole claimant"
      const selectionMargin = selection?.runnerUp
        ? (selection.score ?? 0) - selection.runnerUp.score
        : 1;

      // decisionId is the primary correlation key — unique per request, not per monad.
      const decisionId =
        selection?.reason === "mesh-claim" || selection?.reason === "exploration"
          ? `${fetchStart}:${selection.entry.monad_id}`
          : null;

      if (decisionId && selection) {
        recordDecision({
          decisionId,
          timestamp: fetchStart,
          namespace: parsed.namespace,
          monadId: selection.entry.monad_id,
          score: selection.score ?? 0,
          margin: selectionMargin,
          breakdown: selection.breakdown?.breakdown ?? {},
          ...(selection.runnerUp
            ? { runnerUp: { monad_id: selection.runnerUp.entry.monad_id, score: selection.runnerUp.score } }
            : {}),
        });
      }

      const sampleRate = parseFloat(process.env.MONAD_SCORE_SAMPLE_RATE ?? "0");
      const marginThreshold = parseFloat(process.env.MONAD_SCORE_MARGIN_THRESHOLD ?? "0.05");
      const isFragile = selectionMargin < marginThreshold;
      // always log fragile decisions; sample the rest
      const shouldLog =
        process.env.MONAD_DEBUG_SCORING === "1" ||
        isFragile ||
        (sampleRate > 0 && Math.random() < sampleRate);
      if (shouldLog && selection?.breakdown) {
        const logEntry: Record<string, unknown> = {
          winner: {
            monad_id: selection.entry.monad_id,
            score: selection.score,
            breakdown: selection.breakdown.breakdown,
          },
        };
        if (selection.runnerUp) {
          logEntry.runnerUp = {
            monad_id: selection.runnerUp.entry.monad_id,
            score: selection.runnerUp.score,
          };
          logEntry.margin = parseFloat(selectionMargin.toFixed(4));
        }
        if (isFragile) logEntry.fragile = true;
        console.log("[scoring]", JSON.stringify(logEntry));
      }

      const url = buildForwardUrl(origin, forwardPath, req.query);

      const response = await fetch(url, buildForwardInit(req, parsed.namespace));

      const elapsed = Date.now() - fetchStart;
      console.log(`[bridge] ${req.method} ${url} → ${response.status} (${elapsed}ms)`);

      if (selection) {
        recordForwardResult(selection.entry.monad_id, parsed.namespace, elapsed, response.ok);
        if (decisionId) {
          correlateOutcome(decisionId, elapsed, response.ok);
        }
      }

      const meshMeta = selection
        ? {
            _mesh: {
              origin: meshOrigin,
              monad_id: selection.entry.monad_id,
              monad_name: selection.entry.name ?? null,
              score: selection.score,
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
        // payload.target (when present) is the UPSTREAM monad's own target
        // metadata, carrying the real value nested at target.value (see
        // envelope.ts's nestResponseFields). Spreading payload and then
        // overwriting target with bridgeTarget (this request's own target
        // metadata — the established contract, matching the synthesis
        // branch above) would silently discard that nested value. Extract
        // it first via extractPayloadValue, same helper forwardCandidate()
        // uses, so both bridge paths agree on how to read an upstream envelope.
        const patched =
          payload && typeof payload === "object"
            ? {
                ...payload,
                target: bridgeTarget,
                value: extractPayloadValue(payload),
                ...(selectorDispatch ? { dispatch: selectorDispatch } : {}),
                ...meshMeta,
              }
            : { ok: response.ok, operation: "read", target: bridgeTarget, value: payload, ...(selectorDispatch ? { dispatch: selectorDispatch } : {}), ...meshMeta };
        return res.status(response.status).json(patched);
      }

      const text = await response.text();
      return res.status(response.status).send(text);
    } catch (error) {
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
