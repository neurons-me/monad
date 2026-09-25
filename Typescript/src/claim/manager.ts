import crypto from "crypto";
import fs from "fs";
import path from "path";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";
import type {
  PersistentClaimKeySource,
  PersistentClaimPublicKey,
  PersistentClaimRecord,
  PersistentClaimSummary,
} from "./types.js";

type ClaimStorePaths = {
  claimsDir: string;
  keysDir: string;
};

type ResolvedPemKey = {
  pem: string;
  alg: string;
};

type BuiltClaimBundle = {
  summary: PersistentClaimSummary;
  privateKeyPath: string | null;
  privateKeyPem: string | null;
  persistPrivateKey: boolean;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${entries.join(",")}}`;
}

function normalizeNamespace(raw: unknown) {
  return normalizeNamespaceIdentity(raw);
}

function ensureDirectory(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeNamespaceFilename(namespace: string) {
  return normalizeNamespace(namespace).replace(/[^a-z0-9._-]/g, "_");
}

function normalizePem(key: crypto.KeyObject, type: "public" | "private") {
  if (type === "public") {
    return key.export({ type: "spki", format: "pem" }).toString();
  }

  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

function normalizePublicPem(raw: string): ResolvedPemKey {
  try {
    const key = crypto.createPublicKey(String(raw || "").trim());
    return {
      pem: normalizePem(key, "public"),
      alg: key.asymmetricKeyType || "unknown",
    };
  } catch {
    throw new Error("CLAIM_KEY_INVALID");
  }
}

function normalizePrivatePem(raw: string): { privatePem: string; publicPem: string; alg: string } {
  try {
    const key = crypto.createPrivateKey(String(raw || "").trim());
    const publicKey = crypto.createPublicKey(key);
    return {
      privatePem: normalizePem(key, "private"),
      publicPem: normalizePem(publicKey, "public"),
      alg: key.asymmetricKeyType || publicKey.asymmetricKeyType || "unknown",
    };
  } catch {
    throw new Error("CLAIM_KEY_INVALID");
  }
}

function generateEd25519Keypair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    privatePem: normalizePem(pair.privateKey, "private"),
    publicPem: normalizePem(pair.publicKey, "public"),
    alg: "ed25519",
  };
}

function createKeyKid(publicKeyPem: string) {
  const digest = crypto
    .createHash("sha256")
    .update(String(publicKeyPem || "").trim())
    .digest("hex");
  return `sha256:${digest}`;
}

function buildPublicKeyRecord(
  pem: string,
  alg: string,
  source: PersistentClaimKeySource,
): PersistentClaimPublicKey {
  return {
    kid: createKeyKid(pem),
    alg,
    key: pem,
    source,
  };
}

function signPayload(privateKeyPem: string, payload: string) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const keyType = privateKey.asymmetricKeyType || "unknown";
  const data = Buffer.from(payload);

  if (keyType === "ed25519" || keyType === "ed448") {
    return {
      alg: keyType,
      value: crypto.sign(null, data, privateKey).toString("base64"),
      encoding: "base64" as const,
    };
  }

  return {
    alg: `${keyType}-sha256`,
    value: crypto.sign("sha256", data, privateKey).toString("base64"),
    encoding: "base64" as const,
  };
}

function verifyPayloadSignature(claim: PersistentClaimRecord) {
  const { signature, ...unsigned } = claim;
  const data = Buffer.from(stableStringify(unsigned));
  const sig = Buffer.from(String(signature.value || ""), "base64");
  const proofKey = crypto.createPublicKey(claim.proofKey.key);
  const keyType = proofKey.asymmetricKeyType || claim.proofKey.alg;

  if (keyType === "ed25519" || keyType === "ed448") {
    return crypto.verify(null, data, proofKey, sig);
  }

  return crypto.verify("sha256", data, proofKey, sig);
}

function getClaimStorePaths(): ClaimStorePaths {
  const claimsDir = path.resolve(
    process.cwd(),
    String(process.env.MONAD_CLAIM_DIR || "env/claims"),
  );

  return {
    claimsDir,
    keysDir: path.join(claimsDir, ".keys"),
  };
}

export function getPersistentClaimPath(namespace: string) {
  const { claimsDir } = getClaimStorePaths();
  return path.join(claimsDir, `${sanitizeNamespaceFilename(namespace)}.json`);
}

function getPersistentClaimPrivateKeyPath(namespace: string) {
  const { keysDir } = getClaimStorePaths();
  return path.join(keysDir, `${sanitizeNamespaceFilename(namespace)}.private.pem`);
}

function resolveStoredProofKey(namespace: string) {
  const privateKeyPath = getPersistentClaimPrivateKeyPath(namespace);
  if (!fs.existsSync(privateKeyPath)) {
    return null;
  }

  const stored = normalizePrivatePem(fs.readFileSync(privateKeyPath, "utf8"));
  return {
    privateKeyPath,
    privatePem: stored.privatePem,
    publicPem: stored.publicPem,
    alg: stored.alg,
    source: "stored" as const,
  };
}

function resolveClaimKeys(input: {
  namespace: string;
  publicKey?: string | null;
  privateKey?: string | null;
}) {
  const requestedPublicKey = String(input.publicKey || "").trim();
  const requestedPrivateKey = String(input.privateKey || "").trim();
  const storedProofKey = resolveStoredProofKey(input.namespace);

  if (requestedPrivateKey) {
    const normalized = normalizePrivatePem(requestedPrivateKey);
    if (requestedPublicKey) {
      const normalizedPublic = normalizePublicPem(requestedPublicKey);
      if (normalizedPublic.pem !== normalized.publicPem) {
        throw new Error("CLAIM_KEYPAIR_MISMATCH");
      }
    }

    return {
      namespacePublicKey: buildPublicKeyRecord(
        normalized.publicPem,
        normalized.alg,
        requestedPublicKey ? "provided" : "provided",
      ),
      proofKey: buildPublicKeyRecord(normalized.publicPem, normalized.alg, "provided"),
      proofPrivateKeyPem: normalized.privatePem,
      proofPrivateKeyPath: getPersistentClaimPrivateKeyPath(input.namespace),
      persistPrivateKey: true,
    };
  }

  if (requestedPublicKey) {
    const normalizedPublic = normalizePublicPem(requestedPublicKey);
    if (storedProofKey && storedProofKey.publicPem === normalizedPublic.pem) {
      return {
        namespacePublicKey: buildPublicKeyRecord(normalizedPublic.pem, normalizedPublic.alg, "provided"),
        proofKey: buildPublicKeyRecord(storedProofKey.publicPem, storedProofKey.alg, "stored"),
        proofPrivateKeyPem: storedProofKey.privatePem,
        proofPrivateKeyPath: storedProofKey.privateKeyPath,
        persistPrivateKey: false,
      };
    }

    if (storedProofKey) {
      return {
        namespacePublicKey: buildPublicKeyRecord(normalizedPublic.pem, normalizedPublic.alg, "provided"),
        proofKey: buildPublicKeyRecord(storedProofKey.publicPem, storedProofKey.alg, "stored"),
        proofPrivateKeyPem: storedProofKey.privatePem,
        proofPrivateKeyPath: storedProofKey.privateKeyPath,
        persistPrivateKey: false,
      };
    }

    const generated = generateEd25519Keypair();
    return {
      namespacePublicKey: buildPublicKeyRecord(normalizedPublic.pem, normalizedPublic.alg, "provided"),
      proofKey: buildPublicKeyRecord(generated.publicPem, generated.alg, "generated"),
      proofPrivateKeyPem: generated.privatePem,
      proofPrivateKeyPath: getPersistentClaimPrivateKeyPath(input.namespace),
      persistPrivateKey: true,
    };
  }

  if (storedProofKey) {
    return {
      namespacePublicKey: buildPublicKeyRecord(storedProofKey.publicPem, storedProofKey.alg, "stored"),
      proofKey: buildPublicKeyRecord(storedProofKey.publicPem, storedProofKey.alg, "stored"),
      proofPrivateKeyPem: storedProofKey.privatePem,
      proofPrivateKeyPath: storedProofKey.privateKeyPath,
      persistPrivateKey: false,
    };
  }

  // Neither a client-supplied key NOR a previously-stored one for this
  // namespace: there is nothing to build the namespace's own identity key
  // (namespacePublicKey) from. This used to fall through to
  // generateEd25519Keypair() here, minting and holding the private key on
  // this process's own disk -- a namespace "claimed" that way was never
  // actually sovereign: only the server could ever produce a signature for
  // it, matching neither the claimer's password nor any recovery phrase.
  // Already unreachable from claimNamespace()'s real call path today (a
  // proof is mandatory there, and a valid proof always yields a publicKey
  // before this function is ever called) -- this throw makes that a
  // structural guarantee instead of an accident of today's call order, so
  // a future change to claimNamespace() can't silently resurrect it.
  throw new Error("CLAIM_KEY_REQUIRED");
}

export function buildPersistentClaimBundle(input: {
  namespace: string;
  identityHash: string;
  publicKey?: string | null;
  privateKey?: string | null;
  issuedAt?: number;
}): BuiltClaimBundle {
  const namespace = normalizeNamespace(input.namespace);
  const identityHash = String(input.identityHash || "").trim();
  const issuedAt = Number(input.issuedAt || Date.now());
  const claimPath = getPersistentClaimPath(namespace);
  const resolved = resolveClaimKeys({
    namespace,
    publicKey: input.publicKey,
    privateKey: input.privateKey,
  });

  const unsignedClaim = {
    kind: "PersistentClaimV1" as const,
    version: 1 as const,
    namespace,
    identityHash,
    publicKey: resolved.namespacePublicKey,
    proofKey: resolved.proofKey,
    issuedAt,
  };

  const signature = signPayload(
    resolved.proofPrivateKeyPem,
    stableStringify(unsignedClaim),
  );

  const claim: PersistentClaimRecord = {
    ...unsignedClaim,
    signature,
  };

  if (!verifyPayloadSignature(claim)) {
    throw new Error("CLAIM_PERSIST_FAILED");
  }

  return {
    summary: {
      claimPath,
      claim,
    },
    privateKeyPath: resolved.proofPrivateKeyPath,
    privateKeyPem: resolved.proofPrivateKeyPem,
    persistPrivateKey: resolved.persistPrivateKey,
  };
}

export function writePersistentClaimBundle(bundle: BuiltClaimBundle): PersistentClaimSummary {
  const { claimsDir, keysDir } = getClaimStorePaths();
  ensureDirectory(claimsDir);
  ensureDirectory(keysDir);

  try {
    if (bundle.privateKeyPath && bundle.privateKeyPem && bundle.persistPrivateKey) {
      fs.writeFileSync(bundle.privateKeyPath, bundle.privateKeyPem, { mode: 0o600 });
      fs.chmodSync(bundle.privateKeyPath, 0o600);
    }

    fs.writeFileSync(
      bundle.summary.claimPath,
      `${JSON.stringify(bundle.summary.claim, null, 2)}\n`,
      "utf8",
    );
    return bundle.summary;
  } catch (error) {
    try {
      if (fs.existsSync(bundle.summary.claimPath)) {
        fs.rmSync(bundle.summary.claimPath, { force: true });
      }
    } catch {
    }
    try {
      if (bundle.privateKeyPath && bundle.persistPrivateKey && fs.existsSync(bundle.privateKeyPath)) {
        fs.rmSync(bundle.privateKeyPath, { force: true });
      }
    } catch {
    }
    throw error;
  }
}

export function loadPersistentClaim(namespace: string): PersistentClaimSummary | null {
  const claimPath = getPersistentClaimPath(namespace);
  if (!fs.existsSync(claimPath)) return null;

  const raw = fs.readFileSync(claimPath, "utf8");
  const claim = JSON.parse(raw) as PersistentClaimRecord;
  return {
    claimPath,
    claim,
  };
}

export function verifyPersistentClaim(namespace: string) {
  try {
    const loaded = loadPersistentClaim(namespace);
    if (!loaded) return false;
    return verifyPayloadSignature(loaded.claim);
  } catch {
    return false;
  }
}

export function deletePersistentClaim(namespace: string) {
  const claimPath = getPersistentClaimPath(namespace);
  const privateKeyPath = getPersistentClaimPrivateKeyPath(namespace);

  try {
    if (fs.existsSync(claimPath)) {
      fs.rmSync(claimPath, { force: true });
    }
  } catch {
  }

  try {
    if (fs.existsSync(privateKeyPath)) {
      fs.rmSync(privateKeyPath, { force: true });
    }
  } catch {
  }
}
