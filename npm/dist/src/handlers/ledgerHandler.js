import { getAllBlocks } from "../Blockchain/blockchain.js";
import { getUsersForRootNamespace } from "../Blockchain/users.js";
import { isSystemSemanticPath, listSemanticMemoriesByRootNamespace } from "../claim/memoryStore.js";
import { createEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import { filterBlocksByNamespace, formatObserverRelationLabel, resolveNamespace, resolveNamespaceProjectionRoot, } from "../http/namespace.js";
import { createPathResolverHandler } from "../http/pathResolver.js";
import { htmlShell, wantsHtml } from "../http/shell.js";
function readBlocks(ns, identityHash, limit) {
    const all = getAllBlocks();
    let blocks = filterBlocksByNamespace(all, ns);
    if (identityHash)
        blocks = blocks.filter((b) => String(b?.authorIdentityHash || "") === identityHash);
    return blocks.slice().sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)).slice(0, limit);
}
export function createLedgerHandlers(config) {
    // GET / — HTML shell (with ?target bridge delegation) or ledger read
    const root = (req, res, next) => {
        if (req.query?.target)
            return config.onBridgeRequest(req, res, next);
        if (wantsHtml(req)) {
            const namespace = resolveNamespace(req);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.status(200).send(htmlShell({ providerBoot: config.buildRequestProviderBoot(req, namespace) }));
        }
        return next();
    };
    const rootRead = (req, res) => {
        const chainNs = resolveNamespace(req);
        const target = normalizeHttpRequestToMeTarget(req);
        const lens = formatObserverRelationLabel(target.relation);
        const limit = Math.max(1, Math.min(5000, Number(req.query?.limit ?? 5000)));
        const identityHash = String(req.query?.identityHash || "").trim();
        const rootNamespace = resolveNamespaceProjectionRoot(chainNs) || chainNs;
        const users = getUsersForRootNamespace(rootNamespace);
        const blocks = readBlocks(chainNs, identityHash, limit);
        return res.json(createEnvelope(target, { namespace: chainNs, rootNamespace, lens, users, blocks, count: blocks.length }));
    };
    const blocks = (req, res) => {
        const ns = resolveNamespace(req);
        const target = normalizeHttpRequestToMeTarget(req);
        const lens = formatObserverRelationLabel(target.relation);
        const limit = Math.max(1, Math.min(5000, Number(req.query?.limit ?? 5000)));
        const identityHash = String(req.query?.identityHash || "").trim();
        const result = readBlocks(ns, identityHash, limit);
        return res.json(createEnvelope(target, { namespace: ns, lens, blocks: result, count: result.length }));
    };
    const blockchain = (req, res) => {
        const chainNs = resolveNamespace(req);
        const rootNamespace = resolveNamespaceProjectionRoot(chainNs) || chainNs;
        const target = normalizeHttpRequestToMeTarget(req);
        const lens = formatObserverRelationLabel(target.relation);
        const limit = Math.max(1, Math.min(5000, Number(req.query?.limit ?? 500)));
        const includeSystem = String(req.query?.includeSystem || "").trim() === "1";
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
    const atPath = (req, res) => {
        const chainNs = resolveNamespace(req);
        const target = normalizeHttpRequestToMeTarget(req);
        const lens = formatObserverRelationLabel(target.relation);
        const limit = Math.max(1, Math.min(5000, Number(req.query?.limit ?? 5000)));
        const identityHash = String(req.query?.identityHash || "").trim();
        const result = readBlocks(chainNs, identityHash, limit);
        return res.json(createEnvelope(target, { namespace: chainNs, lens, blocks: result, count: result.length }));
    };
    const catchAll = (req, res) => {
        if (wantsHtml(req)) {
            const namespace = resolveNamespace(req);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.status(200).send(htmlShell({ providerBoot: config.buildRequestProviderBoot(req, namespace) }));
        }
        return createPathResolverHandler()(req, res);
    };
    return { root, rootRead, blocks, blockchain, atPath, catchAll };
}
