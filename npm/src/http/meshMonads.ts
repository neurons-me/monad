import express from "express";
import { listMonadIndexAsync } from "../kernel/monadIndex.js";

export function createMeshMonadsRouter(): express.Router {
  const router = express.Router();

  router.get("/.mesh/monads", async (_req, res) => {
    try {
      const monads = await listMonadIndexAsync();
      return res.json({ ok: true, monads, _meta: { count: monads.length } });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  return router;
}
