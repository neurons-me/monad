import crypto from "crypto";
import type { Memory } from "this.me";
import { appendSemanticMemory, listSemanticMemoriesByNamespace, type SemanticMemoryRow } from "./memoryStore.js";
import { getKernel } from "../kernel/manager.js";
import { normalizeNamespaceIdentity } from "../namespace/identity.js";

export type ReplayMemory = Memory;

type LegacyReplayRecord = {
  payload: unknown;
  identityHash: string;
  timestamp: number;
};

type RecordMemoryInput = {
  namespace: string;
  payload: unknown;
  identityHash?: string | null;
  timestamp?: number;
};

type NamespaceWriteAuthInput = {
  claimIdentityHash: string;
  claimPublicKey?: string | null;
  body: unknown;
};

function nsKey(namespace: string): string {
  return namespace.replace(/\./g, "__");
}

function memPath(namespace: string): string {
  return `daemon.memories.${nsKey(namespace)}`;
}

function nav(root: any, path: string): any {
  return path.split(".").reduce((proxy, key) => proxy[key], root);
}

function kernelGet(path: string): unknown {
  const kernelRead = getKernel() as unknown as (rawPath: string) => unknown;
  return kernelRead(path);
}

function kernelSet(path: string, value: unknown): void {
  nav(getKernel(), path)(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toStableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${toStableJson(obj[k])}`).join(",")}}`;
}

function decodeSignature(rawSignature: string): Buffer | null {
  const sig = String(rawSignature || "").trim();
  if (!sig) return null;
  try {
    return Buffer.from(sig, "base64");
  } catch {
    try { return Buffer.from(sig, "hex"); } catch { return null; }
  }
}

function stripWriteAuthFields(body: Record<string, unknown>) {
  const { signature, signedPayload, signatureEncoding, signatureFormat, ...rest } = body;
  return rest;
}

function verifySignature(publicKey: string, message: string, signature: Buffer): boolean {
  try {
    const key = crypto.createPublicKey(publicKey);
    const keyType = key.asymmetricKeyType || "";
    const payload = Buffer.from(message);
    if (keyType === "ed25519" || keyType === "ed448") {
      return crypto.verify(null, payload, key, signature);
    }
    const verifier = crypto.createVerify("SHA256");
    verifier.update(payload);
    verifier.end();
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

function normalizeOperator(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).trim();
  return normalized || null;
}

function toReplayHash(input: {
  path: string;
  operator: string | null;
  expression: unknown;
  value: unknown;
  timestamp: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      toStableJson({
        path: input.path,
        operator: input.operator,
        expression: input.expression,
        value: input.value,
        timestamp: input.timestamp,
      }),
    )
    .digest("hex");
}

function normalizeMarkerValue(raw: unknown, markerKey: "__ptr" | "__id"): Record<string, unknown> {
  if (isPlainObject(raw) && typeof raw[markerKey] === "string" && raw[markerKey]) {
    return raw;
  }
  return { [markerKey]: String(raw || "") };
}

function materializeReplayMemory(path: string, operator: string | null, data: unknown, hash: string, prevHash: string, timestamp: number): ReplayMemory {
  let expression = data;
  let value = data;

  if (operator === "__" || operator === "->") {
    const ptr = normalizeMarkerValue(data, "__ptr");
    expression = ptr;
    value = ptr;
  } else if (operator === "@") {
    const identity = normalizeMarkerValue(data, "__id");
    expression = identity;
    value = identity;
  } else if (operator === "_" || operator === "~") {
    const masked = typeof data === "string" && data.trim() ? data : "***";
    expression = masked;
    value = masked;
  }

  return {
    path,
    operator,
    expression,
    value,
    hash,
    prevHash,
    timestamp,
  };
}

function semanticRowToReplayMemory(row: SemanticMemoryRow): ReplayMemory {
  return materializeReplayMemory(
    String(row.path || "").trim(),
    normalizeOperator(row.operator),
    row.data,
    String(row.hash || ""),
    String(row.prevHash || ""),
    Number(row.timestamp || Date.now()),
  );
}

function normalizeLegacyReplayMemory(input: unknown): ReplayMemory | null {
  if (!isPlainObject(input)) return null;

  const source = isPlainObject(input.payload) ? input.payload : input;
  const path = String(
    (typeof source.path === "string" && source.path) ||
      (typeof input.expression === "string" && input.expression) ||
      "",
  ).trim();
  if (!path) return null;

  const operator = normalizeOperator(source.operator);
  const hasExpression = Object.prototype.hasOwnProperty.call(source, "expression");
  const hasValue = Object.prototype.hasOwnProperty.call(source, "value");
  let expression = hasExpression ? source.expression : hasValue ? source.value : undefined;
  let value = hasValue ? source.value : expression;

  if (!hasExpression && Object.prototype.hasOwnProperty.call(input, "value")) {
    expression = (input as Record<string, unknown>).value;
    value = expression;
  }

  const timestamp = Number(source.timestamp ?? input.timestamp ?? Date.now());
  const hash = String(source.hash || "").trim() || toReplayHash({
    path,
    operator,
    expression,
    value,
    timestamp,
  });
  const prevHash = String(source.prevHash || "").trim();

  return materializeReplayMemory(path, operator, value, hash, prevHash, timestamp);
}

function toSemanticReplayData(memory: ReplayMemory): unknown {
  if (memory.operator === "__" || memory.operator === "->" || memory.operator === "@") {
    return memory.value ?? memory.expression;
  }
  if (memory.operator === "=" || memory.operator === "?" || memory.operator === null) {
    return memory.value;
  }
  if (memory.operator === "_" || memory.operator === "~") {
    return memory.expression ?? memory.value ?? "***";
  }
  return memory.value ?? memory.expression;
}

function replayMemoryKey(memory: ReplayMemory): string {
  return [
    Number(memory.timestamp || 0),
    String(memory.path || ""),
    String(memory.operator ?? ""),
    String(memory.hash || ""),
  ].join(":");
}

function getLegacyMemoriesForNamespace(namespace: string): ReplayMemory[] {
  const raw = (kernelGet(memPath(namespace)) as LegacyReplayRecord[] | null) ?? [];
  return raw
    .map((entry) => normalizeLegacyReplayMemory(entry))
    .filter((entry): entry is ReplayMemory => Boolean(entry))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function recordMemory(input: RecordMemoryInput): SemanticMemoryRow | null {
  const namespace = normalizeNamespaceIdentity(input.namespace);
  if (!namespace) return null;

  const replay = normalizeLegacyReplayMemory(input.payload);
  if (!replay) return null;

  return appendSemanticMemory({
    namespace,
    path: replay.path,
    operator: replay.operator,
    data: toSemanticReplayData(replay),
    timestamp: Number(input.timestamp || replay.timestamp || Date.now()),
  });
}

export function getMemoriesForNamespace(namespace: string): ReplayMemory[] {
  const ns = normalizeNamespaceIdentity(namespace);
  if (!ns) return [];

  const semanticMemories = listSemanticMemoriesByNamespace(ns, { limit: 10000 })
    .map((row) => semanticRowToReplayMemory(row));
  const legacyMemories = getLegacyMemoriesForNamespace(ns);

  if (!semanticMemories.length) {
    return legacyMemories;
  }

  if (!legacyMemories.length) {
    return semanticMemories.sort((a, b) => a.timestamp - b.timestamp);
  }

  const merged = new Map<string, ReplayMemory>();
  for (const memory of [...semanticMemories, ...legacyMemories]) {
    const key = replayMemoryKey(memory);
    if (!merged.has(key)) {
      merged.set(key, memory);
    }
  }

  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function isNamespaceWriteAuthorized(input: NamespaceWriteAuthInput): boolean {
  const claimIdentityHash = String(input.claimIdentityHash || "").trim();
  if (!claimIdentityHash) return false;

  const body = input.body;
  if (!body || typeof body !== "object") return false;

  const bodyRecord = body as Record<string, unknown>;
  // A matching identityHash alone proves nothing — identityHash is a public
  // fingerprint (keccak256 of the seed, documented as such, displayed in
  // MeLauncher's own UI), not a secret. Anyone who observes a target's
  // identityHash could previously write to their claimed namespace by just
  // echoing it back, no key possession required. Only a verified signature
  // (below) proves the caller actually holds the claim's private key.
  const publicKey = String(input.claimPublicKey || "").trim();
  const rawSignature = String(bodyRecord.signature || "").trim();
  if (!publicKey || !rawSignature) return false;

  const signature = decodeSignature(rawSignature);
  if (!signature) return false;

  const signedPayload = String(bodyRecord.signedPayload || "").trim();
  const message = signedPayload || toStableJson(stripWriteAuthFields(bodyRecord));
  return verifySignature(publicKey, message, signature);
}
