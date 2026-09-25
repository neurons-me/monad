import type express from "express";
import { readSemanticBranchForNamespace, isPathNearSecretScope } from "../claim/memoryStore.js";
import { isForeignUsersPrefixWrite } from "../kernel/manager.js";
import { resolveNamespace } from "./namespace.js";
import { normalizeHttpRequestToMeTarget } from "./meTarget.js";
import { createEnvelope, createErrorEnvelope } from "./envelope.js";
import { refuseUnservedRequestedNamespace } from "./requestedNamespace.js";
import { resolveLogsFromSource, shouldInterceptLogsPath } from "./logsSourceProxy.js";
import { resolveOpenRestyStatusFromSource, shouldInterceptOpenRestyPath } from "./openRestyStatusProxy.js";
import type { DisclosureContent } from "./disclosure.js";

export type ResolvedNamespacePath = {
  namespace: string;
  path: string;
  value?: unknown;
  found: boolean;
  // Internal classification — never sent directly; used to build the wire disclosure
  _classification: "public" | "closed" | "not_found";
};


function normalizeDotPath(input: string): string {
  return String(input || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, ".")
    .split(".")
    .filter(Boolean)
    .join(".");
}

export async function resolveNamespacePathValue(
  namespaceInput: string,
  dotPathInput: string,
): Promise<ResolvedNamespacePath> {
  const namespace = String(namespaceInput || "").trim();
  const dotPath = normalizeDotPath(dotPathInput);

  if (!dotPath) {
    return { namespace, path: dotPath, found: false, _classification: "not_found" };
  }

  // Mirrors kernel/manager.ts's isForeignUsersPrefixWrite() (the write-side
  // fix for the same shape) on the READ side. Verified live before adding
  // this that today's actual read path (readSemanticBranchForNamespace ->
  // buildSemanticBranchTreeForNamespace -> listSemanticMemoriesByNamespaceBranch)
  // does NOT currently leak another namespace's users.<label>.* content when
  // read through the root -- but only as a side effect of memoryToRow()
  // rewriting a matched row's own `path` field to strip that namespace's
  // prefix before the branch tree gets built from it, not because of any
  // guard written for this purpose. That protection is real today and
  // confirmed by a live test (rootWriteDirectionCheck.test.ts), but it is
  // exactly the kind of accidental side effect a later, unrelated refactor
  // of memoryToRow() could silently break. This guard makes the same
  // outcome structural instead of incidental, matching the write side.
  if (isForeignUsersPrefixWrite(namespace, dotPath)) {
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
function toDisclosureContent(classification: ResolvedNamespacePath["_classification"]): DisclosureContent {
  if (classification === "public") return "public";
  return "closed";
}

export function createPathResolverHandler() {
  return async (req: express.Request, res: express.Response) => {
    const rawPath = String(req.path || "");
    const trimmed = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const target = normalizeHttpRequestToMeTarget(req);
    if (!trimmed) {
      return res.status(404).json(createErrorEnvelope(target, { error: "NOT_FOUND" }));
    }

    if (refuseUnservedRequestedNamespace(req, res, (error) => createErrorEnvelope(target, { error }))) return;
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

    // logs/logs.* never resolves against the memory store — see
    // logsSourceProxy.ts's own header for why (an append-only hash-chained
    // log is the wrong place for high-volume, rotating operational data).
    // Handled entirely separately from the public/closed/404 disclosure
    // classification below: logs existing isn't a secret to hide the
    // existence of, it's admin-RBAC-gated, a different, already-
    // established pattern in this mesh (same as netget's own
    // /domains/metadata) — so this returns the source's own error/status
    // directly rather than folding into "closed". shouldInterceptLogsPath
    // requires an exact namespace + exact dotPath match (never a blanket
    // "any namespace asking for logs.*") — see its own doc comment.
    if (shouldInterceptLogsPath(namespace, dotPath)) {
      const logsResult = await resolveLogsFromSource(req, dotPath);
      if (!logsResult.ok) {
        return res.status(logsResult.status).json(createErrorEnvelope(target, {
          namespace,
          path: dotPath,
          error: logsResult.error,
        }));
      }
      return res.json(createEnvelope(target, {
        namespace,
        path: dotPath,
        value: logsResult.value,
        disclosure: "public",
      }));
    }

    // openResty/openResty.<port> never resolves against the memory store
    // either, same reasoning as logs above: this is a live infrastructure
    // fact (is the gateway actually listening right now), re-checked on
    // every read, never a value ever written into the kernel. A confirmed
    // "not listening" is real information and stays visible as a public
    // `value: false` -- it is deliberately NOT folded into "closed"/404,
    // which would make an operator unable to tell "genuinely down" apart
    // from "no permission to see this". See openRestyStatusProxy.ts's own
    // header for the full reasoning and why it's a separate module/env
    // pair from the logs proxy despite sharing one real source today.
    if (shouldInterceptOpenRestyPath(namespace, dotPath)) {
      const statusResult = await resolveOpenRestyStatusFromSource(req, dotPath);
      if (!statusResult.ok) {
        return res.status(statusResult.status).json(createErrorEnvelope(target, {
          namespace,
          path: dotPath,
          error: statusResult.error,
        }));
      }
      return res.json(createEnvelope(target, {
        namespace,
        path: dotPath,
        value: statusResult.value,
        disclosure: "public",
      }));
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
