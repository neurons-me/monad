import type express from "express";
import { claimRequestHandler, openRequestHandler } from "../http/claims.js";
import { claimNamespace, getClaim, openNamespace } from "../claim/records.js";
import { extractLegacyWritePath, getMemoriesForNamespace, getNamespaceChainHead, isNamespaceWriteAuthorized, recordMemory } from "../claim/replay.js";
import { isKeychainReservedPath } from "../claim/keychain.js";
import { isGatewayAuthorityReservedPath } from "../claim/gatewayAuthority.js";
import { isNetgetReservedPath } from "../claim/netget.js";
import { isGatewayRoutingRecordPath, isInternalRequest } from "../http/internalToken.js";
import { saveSnapshot } from "../kernel/manager.js";
import { notify as notifyPathChanged } from "../kernel/pathNotify.js";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import { resolveNamespace } from "../http/namespace.js";
import { computeProofId } from "../infra/hash.js";
import {
  buildKernelCommandTarget,
  buildNormalizedTarget,
  parseBridgeTarget,
} from "../runtime/bridge.js";
import {
  getDefaultReadPolicy,
  isCanonicalClaimableNamespace,
  normalizeClaimableNamespace,
  parseNamespaceIdentity,
} from "../runtime/commands.js";

function claimStatusCode(error: string): number {
  if (error === "NAMESPACE_TAKEN") return 409;
  if (
    error === "NAMESPACE_REQUIRED" || error === "SECRET_REQUIRED"
    || error === "CLAIM_KEY_INVALID"
    || error === "CLAIM_KEYPAIR_MISMATCH" || error === "PROOF_MESSAGE_INVALID"
    || error === "PROOF_NAMESPACE_MISMATCH" || error === "PROOF_TIMESTAMP_INVALID"
  ) return 400;
  if (error === "PROOF_INVALID" || error === "PROOF_REQUIRED") return 403;
  return 500;
}

function openStatusCode(error: string): number {
  if (error === "CLAIM_NOT_FOUND") return 404;
  if (error === "CLAIM_VERIFICATION_FAILED" || error === "IDENTITY_MISMATCH") return 403;
  if (
    error === "NAMESPACE_REQUIRED" || error === "SECRET_REQUIRED"
    || error === "IDENTITY_HASH_REQUIRED"
  ) return 400;
  return 500;
}

// POST /me/* — kernel claim/open commands via me:// URI
export const meCommandHandler: express.RequestHandler = async (req, res) => {
  const rawTarget = decodeURIComponent(String((req.params as any)[0] || "").trim());
  const parsedTarget = parseBridgeTarget(rawTarget.startsWith("me://") ? rawTarget : `me://${rawTarget}`);

  if (!parsedTarget) {
    const target = buildKernelCommandTarget(req, "claim", "");
    return res.status(400).json(createErrorEnvelope(target, {
      error: "TARGET_REQUIRED",
      detail: "Expected a me target after /me/.",
    }));
  }

  if (parsedTarget.namespace !== "kernel" || (parsedTarget.selector !== "claim" && parsedTarget.selector !== "open")) {
    const target = buildKernelCommandTarget(
      req,
      parsedTarget.selector === "open" ? "open" : "claim",
      parsedTarget.pathSlash || parsedTarget.pathDot,
    );
    return res.status(501).json(createErrorEnvelope(target, {
      error: "KERNEL_COMMAND_UNSUPPORTED",
      detail: "Only kernel claim/open commands are implemented on /me/* for now.",
    }));
  }

  const operation = parsedTarget.selector as "claim" | "open";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const namespace = normalizeClaimableNamespace(body.namespace || parsedTarget.pathSlash || parsedTarget.pathDot);
  const target = buildKernelCommandTarget(req, operation, namespace);

  if (!namespace) {
    return res.status(400).json(createErrorEnvelope(target, { error: "NAMESPACE_REQUIRED" }));
  }

  if (!isCanonicalClaimableNamespace(namespace)) {
    return res.status(400).json(createErrorEnvelope(target, {
      error: "FULL_NAMESPACE_REQUIRED",
      detail: "Public claims should use a full namespace such as username.cleaker.me.",
    }));
  }

  if (operation === "claim") {
    const out = await claimNamespace({
      namespace,
      secret: String(body.secret || ""),
      identityHash: String(body.identityHash || "").trim(),
      publicKey: String(body.publicKey || "").trim() || null,
      privateKey: String(body.privateKey || "").trim() || null,
      proof: (body.proof && typeof body.proof === "object") ? body.proof as any : null,
    });

    if (!out.ok) return res.status(claimStatusCode(out.error)).json(createErrorEnvelope(target, { error: out.error }));

    return res.status(201).json(createEnvelope(target, {
      namespace: out.record.namespace,
      identityHash: out.record.identityHash,
      publicKey: out.record.publicKey,
      createdAt: out.record.createdAt,
      persistentClaim: out.persistentClaim,
    }));
  }

  const out = openNamespace({
    namespace,
    secret: String(body.secret || ""),
    identityHash: String(body.identityHash || "").trim(),
  });

  if (!out.ok) return res.status(openStatusCode(out.error)).json(createErrorEnvelope(target, { error: out.error }));

  const memories = getMemoriesForNamespace(out.record.namespace);
  const openedAt = Date.now();
  const audit = {
    proofId: computeProofId({
      namespace: out.record.namespace,
      identityHash: out.record.identityHash,
      noise: out.noise,
      memories,
    }),
    openedAt,
  };

  return res.json(createEnvelope(target, {
    verified: true,
    reasonCode: null,
    reason: null,
    identity: parseNamespaceIdentity(out.record.namespace),
    policy: getDefaultReadPolicy(out.record.namespace),
    audit,
    namespace: out.record.namespace,
    identityHash: out.record.identityHash,
    noise: out.noise,
    memories,
    openedAt,
  }));
};

// Kernel-level claim: no profile fields required — used by programmatic clients (cleaker client)
const rootCompatClaimHandler: express.RequestHandler = async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = normalizeHttpRequestToMeTarget(req);
  const namespace = normalizeClaimableNamespace(String(body.namespace || ""));

  if (!namespace) {
    return res.status(400).json(createErrorEnvelope(target, { error: "NAMESPACE_REQUIRED" }));
  }

  const out = await claimNamespace({
    namespace,
    secret: String(body.secret || ""),
    identityHash: String(body.identityHash || "").trim(),
    publicKey: String(body.publicKey || "").trim() || null,
    privateKey: String(body.privateKey || "").trim() || null,
    proof: (body.proof && typeof body.proof === "object") ? body.proof as any : null,
  });

  if (!out.ok) {
    return res.status(claimStatusCode(out.error)).json(createErrorEnvelope(target, { error: out.error }));
  }

  return res.status(201).json(createEnvelope(target, {
    namespace: out.record.namespace,
    identityHash: out.record.identityHash,
    publicKey: out.record.publicKey,
    createdAt: out.record.createdAt,
    persistentClaim: out.persistentClaim,
  }));
};

// POST / — compat shim: legacy clients send operation:"claim"/"open" to root
export const rootCompatHandler: express.RequestHandler = (req, res, next) => {
  const op = String((req.body as any)?.operation || (req.body as any)?.op || "").trim().toLowerCase();
  if (op === "claim") return rootCompatClaimHandler(req, res, next);
  if (op === "open") return openRequestHandler(req, res, next);
  return next();
};

// POST / — write surface only; claim/open live at POST /claims and POST /claims/open
export const rootCommandHandler: express.RequestHandler = async (req, res) => {
  const body = req.body;
  const target = normalizeHttpRequestToMeTarget(req);

  if (!body || typeof body !== "object") {
    return res.status(400).json(createErrorEnvelope(target, { error: "Expected JSON block in request body" }));
  }

  const namespace = resolveNamespace(req);
  const timestamp = Date.now();
  const claim = getClaim(namespace);

  // The path this write actually targets, resolved the SAME way
  // recordMemory() -> normalizeLegacyReplayMemory() resolves it (checking a
  // nested body.payload.path before body.expression) -- every guard below
  // must read the path through this one shared function, not its own
  // ad hoc copy, or a request shaped to slip past the guard can still land
  // on the reserved location once the real writer resolves it independently.
  const candidatePath = extractLegacyWritePath(body);
  // kernelWrite() (memoryStore.ts) turns a dotted path into a "/"-joined
  // me:// URI (kpath.split(".").join("/")) before it ever reaches the
  // kernel -- so "netget.delegates" and a literal "netget/delegates" from
  // the caller land on the EXACT same physical location, and a
  // startsWith("netget.")-style check that only recognizes the dotted form
  // misses the slash form entirely. isGatewayRoutingRecordPath below
  // already normalizes for exactly this reason; the other reserved-path
  // checks need the same normalization, not their own separate logic.
  const normalizedCandidatePath = candidatePath.replace(/\//g, ".").split(".").filter(Boolean).join(".");

  // keychain.* must only ever be mutated through the dedicated, validated
  // keychain API (permission/vigencia/replay checks, correct keyId
  // derivation) -- never through this generic namespace-write surface,
  // even by the namespace's own claim holder. See keychain.ts's
  // isKeychainReservedPath() for why: this surface would otherwise let a
  // valid claim signature silently overwrite the registry by hand.
  if (isKeychainReservedPath(normalizedCandidatePath)) {
    return res.status(403).json(createErrorEnvelope(target, { error: "KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API" }));
  }
  // daemon.gateways.* must only ever be mutated through the dedicated,
  // signed gateway-authority API (claim/gatewayAuthority.ts) -- same
  // reasoning as the keychain guard directly above, and load-bearing for
  // the identical reason: this branch is kernel-root/namespace-independent
  // storage, and a namespace that legitimately resolves to this monad's
  // own configured root writes UNPREFIXED at literal kernel root via this
  // generic surface (see kernel/manager.ts's isForeignNamespaceCollapsingToRoot()).
  if (isGatewayAuthorityReservedPath(normalizedCandidatePath)) {
    return res.status(403).json(createErrorEnvelope(target, { error: "GATEWAY_PATH_REQUIRES_GATEWAY_API" }));
  }

  // The gateway's routing records decide where a hostname's traffic goes. An
  // unclaimed namespace takes an unsigned write, so without this anyone reaching
  // the monad could add or repoint a domain. Only the machine's own callers
  // (the gateway module, the netget CLI) hold the internal token. Reads the
  // path via extractLegacyWritePath()'s already-resolved candidatePath, not
  // its own re-derivation, for the same reason the other guards do now --
  // this function does its own slash/dot normalization internally already.
  if (isGatewayRoutingRecordPath(candidatePath) && !isInternalRequest(req)) {
    return res.status(403).json(createErrorEnvelope(target, { error: "GATEWAY_ROUTING_RECORDS_REQUIRE_INTERNAL_CALLER" }));
  }

  // netget.* is this namespace's own physical-resource declaration (domains,
  // ports, certs, delegates -- Surface-Identity-Claims.md §7.1/§7.7), meant
  // to be ordinary namespace tree data once claimed, gated by nothing more
  // than the same signature check every other write to that namespace
  // already gets below. But an UNCLAIMED namespace has no claim to check a
  // signature against at all -- the `if (claim)` block below is simply
  // skipped -- so without this guard, anyone could write netget.delegates
  // (or any other netget.* path) for any never-claimed namespace completely
  // unsigned, and meshAnnounce.ts's isNamespaceUsableByIdentity() would read
  // a resulting delegates entry as a real delegation. Unlike the two guards
  // above, this one is conditional on claim state, not unconditional: once
  // the namespace is claimed, netget.* writes fall through to the ordinary
  // signature check like any other namespace data -- no dedicated API
  // needed for it, unlike keychain.*/daemon.gateways.*.
  if (isNetgetReservedPath(normalizedCandidatePath) && !claim) {
    return res.status(403).json(createErrorEnvelope(target, { error: "NETGET_PATH_REQUIRES_CLAIM" }));
  }

  if (claim) {
    const authorized = isNamespaceWriteAuthorized({
      claimIdentityHash: claim.identityHash,
      claimPublicKey: claim.publicKey,
      body,
    });
    if (!authorized) {
      return res.status(403).json(createErrorEnvelope(target, { error: "NAMESPACE_WRITE_FORBIDDEN" }));
    }

    // isNamespaceWriteAuthorized() only ever proves "the claim holder signed
    // exactly this body" -- nothing before this bound WHICH namespace or
    // WHEN. Both are real gaps (Surface-Identity-Claims.md §7.7): (a) the
    // same signed body, replayed later, was still valid -- a stale signed
    // grant could silently un-revoke a delegate; (b) one key holding claims
    // on two namespaces could have a write meant for one replayed against
    // the other, since nothing in the signature tied it to either. Requiring
    // the signed body to name the target namespace AND the chain head it was
    // signed against (getNamespaceChainHead) closes both: a signature is now
    // valid for exactly one write, in one namespace, at one moment.
    //
    // No fallback for a body missing these fields -- accepting the old
    // (unbound) signed-body shape "for now" would leave this gap open for
    // any caller that simply doesn't send them. Every real signer (GUI's
    // createCleakerSession.ts, the curl walkthrough in the docs) was updated
    // in the same change that added this check.
    const expectedHeadHash = getNamespaceChainHead(namespace, claim);
    const bodyNamespace = String((body as Record<string, unknown>).namespace || "").trim();
    const bodyExpectedHeadHash = String((body as Record<string, unknown>).expectedHeadHash || "").trim();
    if (bodyNamespace !== namespace || bodyExpectedHeadHash !== expectedHeadHash) {
      return res.status(409).json(createErrorEnvelope(target, {
        error: "STALE_HEAD",
        detail: "This namespace's state has changed since the write was signed (or the signed body never named this namespace/head). Re-read the current head and re-sign.",
        expectedHeadHash,
      }));
    }
  }

  const blockIdentityHash = claim
    ? claim.identityHash
    : String((body as any).identityHash || "").trim();

  let entry;
  try {
    entry = recordMemory({ namespace, payload: body, identityHash: blockIdentityHash, timestamp });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    // appendSemanticMemory's own guard (memoryStore.ts): `namespace` here
    // came from resolveNamespace(req) -- an unrecognized/unresolved Host
    // header falls back to a literal string ("unknown") that has no claim
    // to verify against (the `if (claim)` branch above is simply skipped),
    // meaning this request needed no identity at all to reach this write.
    // Proven exploitable end-to-end in
    // namespaceCollisionAuthorization.test.ts before this guard existed.
    if (code === "FOREIGN_NAMESPACE_REJECTED") {
      return res.status(403).json(createErrorEnvelope(target, {
        error: "FOREIGN_NAMESPACE_REJECTED",
        detail: "This request's namespace does not resolve to the monad's real root or a sub-identity of it -- it cannot be used as a write target here.",
      }));
    }
    // The underlying kernel write (this.me's self:write) throws on certain
    // malformed payloads — e.g. a null/undefined value, even with a valid
    // operator. That's a request-level error, not a process-level one; let
    // it surface as 400 instead of taking the whole daemon down (confirmed
    // by testing: this used to crash the process with an uncaught exception).
    return res.status(400).json(createErrorEnvelope(target, {
      error: "INVALID_MEMORY_INPUT",
      detail: code,
    }));
  }
  if (!entry) {
    return res.status(400).json(createErrorEnvelope(target, { error: "INVALID_MEMORY_INPUT" }));
  }

  // Persist immediately so writes survive monad restarts.
  saveSnapshot();

  // Push a live update to any /nrp WebSocket connections subscribed to this
  // path or one of its ancestors/descendants (see kernel/pathNotify.ts and
  // http/nrpHandler.ts's 'subscribe' handling). entry.path is the exact
  // dotted path recordMemory() parsed out of this write's expression/value.
  if (entry?.path) {
    notifyPathChanged(namespace, entry.path);
  }

  console.log("🧠 New Memory Event:");
  console.log(JSON.stringify(entry, null, 2));
  const writeTarget = buildNormalizedTarget(req, namespace, "write", "");
  return res.json(createEnvelope(writeTarget, {
    memoryHash: entry?.hash || null,
    prevMemoryHash: entry?.prevHash || null,
    namespace,
    path: entry?.path || String((body as any).expression || "").trim(),
    operator: entry?.operator ?? null,
    timestamp: entry?.timestamp || timestamp,
  }));
};

// GET /api/v1/write-head?namespace=... — the chain head a signer must bind
// into a write's signed body (namespace + expectedHeadHash, see
// rootCommandHandler's own check above and Surface-Identity-Claims.md
// §7.7). A successful write's own response already carries its new
// `memoryHash` as the next head, so a client mid-session can chain off that
// directly -- this endpoint exists for a session's first write (or after any
// externally-caused change) when there's no prior write response to read it
// from. Requires an existing claim: an unclaimed namespace has no signed
// writes to protect, and returning a head for one would just be extra
// surface for no purpose.
export const writeHeadHandler: express.RequestHandler = (req, res) => {
  const namespace = normalizeClaimableNamespace(String(req.query.namespace || ""));
  const target = normalizeHttpRequestToMeTarget(req);
  if (!namespace) {
    return res.status(400).json(createErrorEnvelope(target, { error: "NAMESPACE_REQUIRED" }));
  }
  const claim = getClaim(namespace);
  if (!claim) {
    return res.status(404).json(createErrorEnvelope(target, { error: "CLAIM_NOT_FOUND" }));
  }
  return res.json(createEnvelope(target, {
    namespace,
    expectedHeadHash: getNamespaceChainHead(namespace, claim),
  }));
};
