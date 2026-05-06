import express from "express";
import { findMonadByNameAsync, findMonadsForNamespaceAsync } from "../kernel/monadIndex.js";
export function createMeshResolveRouter() {
    const router = express.Router();
    // GET /.mesh/resolve?namespace=suis-macbook-air.local
    // GET /.mesh/resolve?monad=frank
    router.get("/.mesh/resolve", async (req, res) => {
        try {
            const ns = String(req.query?.namespace || "").trim();
            const monadName = String(req.query?.monad || "").trim();
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
        }
        catch (error) {
            return res.status(500).json({ ok: false, error: error?.message || String(error) });
        }
    });
    return router;
}
