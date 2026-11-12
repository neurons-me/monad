import express from "express";
import { getUser } from "../Blockchain/users.js";
import { normalizeHttpRequestToMeTarget } from "./meTarget.js";
import { createErrorEnvelope } from "./envelope.js";

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

  // POST /users -- DISABLED (2026-11-12). It took {username, identityHash, publicKey} with no proof and appended five
  // memories in the ROOT namespace at users.<username>.*, with the username only trimmed and lowercased. A dotted name
  // reached inside any namespace's storage, claimed ones included, past every write check of the normal surfaces:
  // measured on a disposable monad, it changed a claimed namespace's data and moved its write head with no signature,
  // replaced an active keychain key record (the owner's key then answered ACTING_KEY_REVOKED), and wrote under the
  // gateway's reserved domain records past the internal-caller guard. It never let anyone sign in or claim as someone
  // else (claims decide on the claim record). No caller was found in GUI, cleaker or netget. Closed outright, not
  // patched by refusing dots: a name is registered by claiming its namespace (POST /claims).
  router.post("/users", (req: express.Request, res: express.Response) => {
    const target = normalizeHttpRequestToMeTarget(req);
    res.status(410).json(createErrorEnvelope(target, {
      error: "LEGACY_USERS_WRITE_DISABLED",
      message: "POST /users is disabled: it wrote directory records with no proof. A name is registered by claiming its namespace (POST /claims).",
    }));
  });

  return router;
}
