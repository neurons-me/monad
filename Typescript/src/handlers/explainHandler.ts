import type express from "express";
import { getKernel, kernelPathFor } from "../kernel/manager.js";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import { resolveNamespace } from "../http/namespace.js";

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
    const explanation = (getKernel() as any).explain(kpath);
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
    const inspection = (getKernel() as any).inspect(last !== undefined ? { last } : undefined);
    return res.json(createEnvelope(target, { inspection }));
  } catch (error) {
    return res.status(500).json(createErrorEnvelope(target, {
      error: "INSPECT_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
};
