import express from "express";
import { findMonadByNameAsync, findMonadsForNamespaceAsync } from "../kernel/monadIndex.js";
import { selectMeshClaimants } from "../kernel/meshSelectMulti.js";
import { DEFAULT_STALE_MS } from "../kernel/meshSelect.js";

export function createMeshResolveRouter(): express.Router {
  const router = express.Router();

  // GET /.mesh/resolve?namespace=suis-macbook-air.local
  // GET /.mesh/resolve?monad=frank
  router.get("/.mesh/resolve", async (req, res) => {
    try {
      const ns = String((req.query as any)?.namespace || "").trim();
      const monadName = String((req.query as any)?.monad || "").trim();

      if (monadName) {
        const entry = await findMonadByNameAsync(monadName);
        return res.json({
          ok: !!entry,
          query: { monad: monadName },
          monad: entry ?? null,
        });
      }

      if (!ns) {
        return res.status(400).json({
          ok: false,
          error: "NAMESPACE_OR_MONAD_REQUIRED",
          hint: "Provide ?namespace=xxx or ?monad=name",
        });
      }

      const monads = await findMonadsForNamespaceAsync(ns);
      return res.json({
        ok: true,
        query: { namespace: ns },
        monads,
        _meta: { count: monads.length },
      });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  // GET /.mesh/resolve/multi?namespace=suis-macbook-air.local
  //   &max=3          — max candidates to return (default 3, min 1, max 10)
  //   &min_score=0.8  — minRelativeScore filter (default 0.8)
  //   &staleness=300000 — staleness window in ms (default 300000)
  //   &selector=tag:primary — optional DNF selector constraint
  //
  // Returns the scored candidate list used by Phase 10 Total Monad Synthesis.
  // This is an observability/debug endpoint — it does NOT forward requests.
  // Use it to understand which monads would be queried for a namespace before
  // enabling MONAD_SYNTHESIS_ENABLED=1 in production.
  //
  // Response shape:
  //   {
  //     ok: true,
  //     namespace: string,
  //     selectedAt: number,
  //     candidates: Array<{
  //       monad_id, name?, endpoint, namespace, score,
  //       breakdown: { total, recency, resonance, latency, scorers }
  //     }>,
  //     _meta: { count, maxRequested, minRelativeScore, stalenessMs }
  //   }
  router.get("/.mesh/resolve/multi", async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const ns = String(q.namespace ?? "").trim();
      if (!ns) {
        return res.status(400).json({
          ok: false,
          error: "NAMESPACE_REQUIRED",
          hint: "Provide ?namespace=xxx",
        });
      }

      // Parse optional controls with safe defaults and bounds
      const maxRaw = parseInt(q.max ?? "", 10);
      const maxCandidates = Number.isFinite(maxRaw) ? Math.min(10, Math.max(1, maxRaw)) : 3;

      const minRaw = parseFloat(q.min_score ?? "");
      const minRelativeScore = Number.isFinite(minRaw) ? Math.min(1, Math.max(0, minRaw)) : 0.8;

      const staleRaw = parseInt(q.staleness ?? "", 10);
      const stalenessMs = Number.isFinite(staleRaw) && staleRaw > 0 ? staleRaw : DEFAULT_STALE_MS;

      const selectorConstraint = q.selector ? String(q.selector) : null;

      // selfEndpoint / selfMonadId — read from env so self-monad is excluded,
      // same as selectMeshClaimant does in the bridge.
      const selfEndpoint = process.env.MONAD_SELF_ENDPOINT ?? "";
      const selfMonadId = process.env.MONAD_ID ?? "";

      const selection = await selectMeshClaimants({
        namespace: ns,
        selfEndpoint,
        selfMonadId,
        selectorConstraint,
        stalenessMs,
        maxCandidates,
        minRelativeScore,
      });

      return res.json({
        ok: true,
        namespace: selection.namespace,
        selectedAt: selection.selectedAt,
        candidates: selection.candidates.map((c) => ({
          monad_id: c.entry.monad_id,
          name: c.entry.name ?? null,
          endpoint: c.entry.endpoint,
          namespace: c.entry.namespace,
          score: c.score,
          breakdown: c.breakdown,
        })),
        _meta: {
          count: selection.candidates.length,
          maxRequested: maxCandidates,
          minRelativeScore,
          stalenessMs,
        },
      });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  return router;
}
