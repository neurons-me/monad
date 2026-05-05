import express from "express";
import { listMonadIndex } from "../kernel/monadIndex.js";

export function createMeshMonadsRouter(): express.Router {
  const router = express.Router();

  router.get("/.mesh/monads", (_req, res) => {
    try {
      const monads = listMonadIndex();
      return res.json({ ok: true, monads });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  return router;
}
