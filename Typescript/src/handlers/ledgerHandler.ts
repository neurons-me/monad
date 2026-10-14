import type express from "express";
import { getAllBlocks } from "../Blockchain/blockchain.js";
import { getUsersForRootNamespace } from "../Blockchain/users.js";
import { isRecognizedOwnRootConstant } from "../kernel/manager.js";
import { normalizeNamespaceIdentity, normalizeNamespaceRootName } from "../namespace/identity.js";
import { isSystemSemanticPath, listSemanticMemoriesByRootNamespace } from "../claim/memoryStore.js";
import { createEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import {
  filterBlocksByNamespace,
  formatObserverRelationLabel,
  resolveNamespace,
  resolveNamespaceProjectionRoot,
} from "../http/namespace.js";
import { isReadByNetworkAddress } from "../http/requestedNamespace.js";
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

/**
 * The directory a read of `/` may show to the address that asked.
 *
 *   the root's own address      the directory of users under it (what that address IS);
 *   an address that is one user the user's own row, and nothing else;
 *   any other name              none.
 *
 * The directory belongs to the root's context. An address under the root is another context: it used to receive the
 * root's whole directory (usernames and identity hashes), so a name nobody had created showed everyone under the root.
 * `rootNamespace` stays in the answer: it says under which root the address sits, it is not data of the root.
 * Spellings are compared resolved (`alice.localhost` and `alice.<this machine's root>` are one address).
 * `askedByAddress`: the request reached the monad by an IP literal with no forwarded host (see below).
 */
function usersVisibleFrom(chainNs: string, rootNamespace: string, askedByAddress = false) {
  const own = normalizeNamespaceIdentity(chainNs);
  const root = normalizeNamespaceIdentity(rootNamespace);
  // An address that names no namespace this monad serves resolves to "unknown", and the kernel maps every namespace it
  // does not know onto its own root's storage: asking for the directory of "unknown" is asking for the root's. Only an
  // address that IS this monad's own root may have it.
  const isOwnRoot = (!own || own === root) && isRecognizedOwnRootConstant(normalizeNamespaceRootName(own || root));
  // A read by network ADDRESS (an IP literal, no forwarded name) is the monad answering as itself: it is how the
  // directory consumers (the GUI's users table and search) have always read it. It names no other context.
  if (isOwnRoot || askedByAddress) return getUsersForRootNamespace(rootNamespace);
  if (!own || own === root) return [];
  const directory = getUsersForRootNamespace(rootNamespace);
  const suffix = `.${root}`;
  if (!root || !own.endsWith(suffix)) return [];
  const handle = own.slice(0, -suffix.length);
  if (!handle || handle.includes(".")) return [];
  return directory.filter((u: any) => String(u?.username ?? "").toLowerCase() === handle);
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
    const askedByAddress = isReadByNetworkAddress(req);
    const users = usersVisibleFrom(chainNs, rootNamespace, askedByAddress);
    const blocks = readBlocks(chainNs, identityHash, limit);
    return res.json(createEnvelope(target, { namespace: chainNs, rootNamespace, lens, users, blocks, count: blocks.length }));
  };

  // /blocks and /blockchain are data endpoints AND names of pages a front end
  // may have: a browser opening the URL gets the shell (the catch-all below),
  // a data request -- which never asks for text/html -- gets the ledger.
  const blocks: express.RequestHandler = (req, res, next) => {
    if (wantsHtml(req)) return next();
    const ns = resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 5000)));
    const identityHash = String((req.query as any)?.identityHash || "").trim();
    const result = readBlocks(ns, identityHash, limit);
    return res.json(createEnvelope(target, { namespace: ns, lens, blocks: result, count: result.length }));
  };

  const blockchain: express.RequestHandler = (req, res, next) => {
    if (wantsHtml(req)) return next();
    const chainNs = resolveNamespace(req);
    const rootNamespace = resolveNamespaceProjectionRoot(chainNs) || chainNs;
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 500)));
    const includeSystem = String((req.query as any)?.includeSystem || "").trim() === "1";
    const memories = listSemanticMemoriesByRootNamespace(rootNamespace, { limit, includeSystem });
    const systemHidden = includeSystem
      ? 0
      : listSemanticMemoriesByRootNamespace(rootNamespace, { limit: 5000, includeSystem: true })
        .filter((row) => isSystemSemanticPath(row.path)).length;
    return res.json(createEnvelope(target, {
      namespace: chainNs,
      rootNamespace,
      lens,
      memories,
      count: memories.length,
      systemHidden,
    }));
  };

  const atPath: express.RequestHandler = (req, res) => {
    const chainNs = resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const limit = Math.max(1, Math.min(5000, Number((req.query as any)?.limit ?? 5000)));
    const identityHash = String((req.query as any)?.identityHash || "").trim();
    const result = readBlocks(chainNs, identityHash, limit);

    // When the path has a sub-path after @user (e.g. /@jabellae/name), fall through
    // to the semantic path resolver. Blockchain blocks live at /@user only.
    const rawPath = String(req.path || "");
    const segments = rawPath.replace(/^\/+/, "").split("/").filter(Boolean);
    const hasSubPath = segments.length > 1; // more than just "@user"

    if (hasSubPath && result.length === 0) {
      return createPathResolverHandler()(req, res);
    }

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
