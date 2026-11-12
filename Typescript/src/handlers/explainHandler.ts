import type express from "express";
import { getKernel, kernelPathFor } from "../kernel/manager.js";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import { resolveNamespace } from "../http/namespace.js";
import { mayReachGatewayRecords, mayReadGatewayRecords, withoutGatewayRecordIndex, withoutGatewayRecordRows } from "../http/gatewayRecordDisclosure.js";

// POST /explain — generic kernel provenance lookup. Not netget-specific:
// any app that mounts a `this.gui` Inspector against a real `me` object
// (see hasKernelExplain() in this.gui's runtime/inspector.tsx) reaches this
// once it points its `me.explain` at a monad instead of a local-only kernel.
export const explainRequestHandler: express.RequestHandler = async (req, res) => {
  const target = normalizeHttpRequestToMeTarget(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const path = String(body.path || "").trim();

  if (!path) {
    return res.status(400).json(createErrorEnvelope(target, { error: "PATH_REQUIRED" }));
  }

  const namespace = resolveNamespace(req);
  const kpath = kernelPathFor(namespace, path);

  try {
    // The gateway's domain records (gatewayRecordDisclosure.ts): explain can evaluate wildcards and aggregates, so a
    // path that could reach one is answered as a path with nothing at it, before anything is evaluated.
    if (!mayReadGatewayRecords(req) && (mayReachGatewayRecords(path) || mayReachGatewayRecords(kpath))) {
      return res.json(createEnvelope(target, { path, explanation: { path, expr: null, derivation: null, meta: { dependsOn: [] } } }));
    }
    const explanation = (getKernel() as any).explain(kpath);
    if (!mayReadGatewayRecords(req)) {
      const deps: string[] = [
        ...(((explanation?.meta?.dependsOn) ?? []) as unknown[]).map(String),
        ...((((explanation?.derivation?.inputs) ?? []) as Array<{ path?: unknown }>).map((i) => String(i?.path ?? ""))),
        String(explanation?.path ?? ""),
      ];
      if (deps.some((d) => d && mayReachGatewayRecords(d))) {
        return res.json(createEnvelope(target, { path, explanation: { path, expr: null, derivation: null, meta: { dependsOn: [] } } }));
      }
    }
    return res.json(createEnvelope(target, { path, explanation }));
  } catch (error) {
    return res.status(500).json(createErrorEnvelope(target, {
      error: "EXPLAIN_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
};

// POST /inspect — generic kernel inspection (recent memories, etc).
export const inspectRequestHandler: express.RequestHandler = async (req, res) => {
  const target = normalizeHttpRequestToMeTarget(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const last = Number.isFinite(Number(body.last)) ? Number(body.last) : undefined;

  try {
    const raw = (getKernel() as any).inspect(last !== undefined ? { last } : undefined);
    // The gateway's domain records are left out of the inspection (gatewayRecordDisclosure.ts).
    const inspection = mayReadGatewayRecords(req) || !raw || typeof raw !== "object"
      ? raw
      : { ...raw, memories: withoutGatewayRecordRows(Array.isArray(raw.memories) ? raw.memories : []), index: withoutGatewayRecordIndex(raw.index) };
    return res.json(createEnvelope(target, { inspection }));
  } catch (error) {
    return res.status(500).json(createErrorEnvelope(target, {
      error: "INSPECT_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
};
