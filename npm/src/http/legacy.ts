import express from "express";
import { claimUser, getUser } from "../Blockchain/users.js";

export function createLegacyRouter(): express.Router {
  const router = express.Router();

  // Fetch a single claimed username.
  router.get("/users/:username", (req: express.Request, res: express.Response) => {
    const username = String(req.params.username || "").trim().toLowerCase();
    if (!username) return res.status(400).json({ ok: false, error: "USERNAME_REQUIRED" });

    const user = getUser(username);
    if (!user) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

    return res.json({ ok: true, user });
  });

  // Claim a username on this host's ledger.
  router.post("/users", (req: express.Request, res: express.Response) => {
    const body = req.body ?? {};
    const username = String(body.username || "").trim().toLowerCase();
    const identityHash = String(body.identityHash || "").trim();
    const publicKey = String(body.publicKey || "").trim();

    if (!username) return res.status(400).json({ ok: false, error: "USERNAME_REQUIRED" });
    if (!identityHash) return res.status(400).json({ ok: false, error: "IDENTITY_HASH_REQUIRED" });
    if (!publicKey) return res.status(400).json({ ok: false, error: "PUBLIC_KEY_REQUIRED" });

    const out = claimUser(username, identityHash, publicKey);
    if (!out.ok) return res.status(409).json(out);

    return res.json({ ok: true, username });
  });

  return router;
}
