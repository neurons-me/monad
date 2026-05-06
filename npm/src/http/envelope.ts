import type { NormalizedMeTarget } from "./meTarget.js";
import { buildDisclosureOrigin, isDisclosureEnabled } from "./disclosure.js";

type EnvelopeShape = Record<string, unknown>;

type NamespaceShape = {
  me: string;
  host: string;
};

function isNamespaceShape(value: unknown): value is NamespaceShape {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Record<string, unknown>;
  return typeof maybe.me === "string" && typeof maybe.host === "string";
}

function normalizeNamespaceValue(
  value: unknown,
  host: string,
  fallbackMe: string,
): NamespaceShape {
  if (isNamespaceShape(value)) return value;
  const me = typeof value === "string" && value.trim() ? value.trim() : fallbackMe;
  return {
    me,
    host,
  };
}

function normalizeTarget(target: NormalizedMeTarget) {
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

function normalizeEnvelopeBody(body: EnvelopeShape, target: ReturnType<typeof normalizeTarget>) {
  const out: EnvelopeShape = { ...body };
  if ("namespace" in out) {
    out.namespace = normalizeNamespaceValue(out.namespace, target.namespace.host, target.namespace.me);
  }
  return out;
}

function nestResponseFields(
  normalizedTarget: ReturnType<typeof normalizeTarget>,
  body: EnvelopeShape,
) {
  const target: EnvelopeShape = { ...normalizedTarget };
  const remaining: EnvelopeShape = { ...body };
  const nestKeys = ["namespace", "path", "value"];
  for (const key of nestKeys) {
    if (key in remaining) {
      target[key] = remaining[key];
      delete remaining[key];
    }
  }
  return { target, remaining };
}

export function createEnvelope(
  target: NormalizedMeTarget,
  body: EnvelopeShape = {},
): EnvelopeShape {
  const normalizedTarget = normalizeTarget(target);
  const normalizedBody = normalizeEnvelopeBody(body, normalizedTarget);
  const { target: nestedTarget, remaining } = nestResponseFields(normalizedTarget, normalizedBody);
  const base: EnvelopeShape = { ok: true, target: nestedTarget, ...remaining };
  if (isDisclosureEnabled()) {
    base._disclosure = { status: "ok", path: normalizedTarget.path, origin: buildDisclosureOrigin() };
  }
  return base;
}

export function createErrorEnvelope(
  target: NormalizedMeTarget,
  body: EnvelopeShape = {},
): EnvelopeShape {
  const normalizedTarget = normalizeTarget(target);
  const normalizedBody = normalizeEnvelopeBody(body, normalizedTarget);
  const { target: nestedTarget, remaining } = nestResponseFields(normalizedTarget, normalizedBody);
  const base: EnvelopeShape = { ok: false, target: nestedTarget, ...remaining };
  if (isDisclosureEnabled()) {
    base._disclosure = { status: "error", path: normalizedTarget.path, origin: buildDisclosureOrigin() };
  }
  return base;
}
