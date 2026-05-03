import type express from "express";
import {
  formatObserverRelationQuery,
  resolveNamespace,
  resolveObserverRelation,
  resolveTransportHost,
  type ObserverRelation,
} from "./namespace.js";

export type MeOperationKind = "read" | "write" | "claim" | "open";

export interface NormalizedMeTarget {
  host: string;
  namespace: string;
  operation: MeOperationKind;
  path: string;
  nrp: string;
  relation: ObserverRelation;
}

function normalizePathSegments(rawPath: string) {
  const trimmed = String(rawPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";

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

function inferOperation(req: express.Request): MeOperationKind {
  if (req.method === "POST" && req.path === "/claims") return "claim";
  if (req.method === "POST" && req.path === "/claims/signIn") return "open";
  if (req.method === "POST" && req.path === "/claims/open") return "open";
  if (req.method === "POST") return "write";
  return "read";
}

function inferNamespace(req: express.Request): string {
  const operation = inferOperation(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hinted = String(body.namespace || "").trim();
  if (hinted) return hinted;
  if (operation === "claim" || operation === "open") {
    return resolveNamespace(req);
  }
  return resolveNamespace(req);
}

export function buildMeTargetNrp(
  namespace: string,
  operation: MeOperationKind,
  path: string,
  relation: ObserverRelation,
) {
  const normalizedPath = path || "_";
  return `me://${namespace}:${operation}/${normalizedPath}${formatObserverRelationQuery(relation)}`;
}

export function normalizeHttpRequestToMeTarget(req: express.Request): NormalizedMeTarget {
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
