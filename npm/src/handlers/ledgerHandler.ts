import type express from "express";
import { getAllBlocks } from "../Blockchain/blockchain.js";
import { getUsersForRootNamespace } from "../Blockchain/users.js";
import { listSemanticMemoriesByRootNamespace } from "../claim/memoryStore.js";
import { createEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import {
  filterBlocksByNamespace,
  formatObserverRelationLabel,
  resolveNamespace,
  resolveNamespaceProjectionRoot,
} from "../http/namespace.js";
import { createPathResolverHandler } from "../http/pathResolver.js";
import { htmlShell, wantsHtml } from "../http/shell.js";
import type { NamespaceProviderBoot } from "../http/provider.js";

export type LedgerHandlerConfig = {
  buildRequestProviderBoot: (req: express.Request, namespace: string) => NamespaceProviderBoot | null;
  onBridgeRequest: express.RequestHandler;
};

export type LedgerHandlers = {
  root: express.RequestHandler;
  rootRead: express.RequestHandler;
  blocks: express.RequestHandler;
  blockchain: express.RequestHandler;
  atPath: express.RequestHandler;
  catchAll: express.RequestHandler;
};

function readBlocks(ns: string, identityHash: string, limit: number) {
  const all = getAllBlocks();
  let blocks = filterBlocksByNamespace(all, ns);
  if (identityHash) blocks = blocks.filter((b: any) => String(b?.authorIdentityHash || "") === identityHash);
  return blocks.slice().sort((a: any, b: any) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)).slice(0, limit);
}

export function createLedgerHandlers(config: LedgerHandlerConfig): LedgerHandlers {
  // GET / — HTML shell (with ?target bridge delegation) or ledger read
  const root: express.RequestHandler = (req, res, next) => {
    if ((req.query as any)?.target) return config.onBridgeRequest(req, res, next);
    if (wantsHtml(req)) {
      const namespace = resolveNamespace(req);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(htmlShell({ providerBoot: config.buildRequestProviderBoot(req, namespace) }));
    }
    return next();
  };

  const rootRead: express.RequestHandler = (req, res) => {
    const chainNs = resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 5000)));
    const identityHash = String((req.query as any)?.identityHash || "").trim();
    const rootNamespace = resolveNamespaceProjectionRoot(chainNs) || chainNs;
    const users = getUsersForRootNamespace(rootNamespace);
    const blocks = readBlocks(chainNs, identityHash, limit);
    return res.json(createEnvelope(target, { namespace: chainNs, rootNamespace, lens, users, blocks, count: blocks.length }));
  };

  const blocks: express.RequestHandler = (req, res) => {
    const ns = resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 5000)));
    const identityHash = String((req.query as any)?.identityHash || "").trim();
    const result = readBlocks(ns, identityHash, limit);
    return res.json(createEnvelope(target, { namespace: ns, lens, blocks: result, count: result.length }));
  };

  const blockchain: express.RequestHandler = (req, res) => {
    const chainNs = resolveNamespace(req);
    const rootNamespace = resolveNamespaceProjectionRoot(chainNs) || chainNs;
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 500)));
    const memories = listSemanticMemoriesByRootNamespace(rootNamespace, { limit });
    return res.json(createEnvelope(target, { namespace: chainNs, rootNamespace, lens, memories, count: memories.length }));
  };

  const atPath: express.RequestHandler = (req, res) => {
    const chainNs = resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 5000)));
    const identityHash = String((req.query as any)?.identityHash || "").trim();
    const result = readBlocks(chainNs, identityHash, limit);
    return res.json(createEnvelope(target, { namespace: chainNs, lens, blocks: result, count: result.length }));
  };

  const catchAll: express.RequestHandler = (req, res) => {
    if (wantsHtml(req)) {
      const namespace = resolveNamespace(req);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(htmlShell({ providerBoot: config.buildRequestProviderBoot(req, namespace) }));
    }
    return createPathResolverHandler()(req, res);
  };

  return { root, rootRead, blocks, blockchain, atPath, catchAll };
}
