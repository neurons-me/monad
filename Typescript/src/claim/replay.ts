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

// Exported for reuse by anything else that needs the SAME canonical-JSON +
// PEM-Ed25519-verify convention this file already proved out (namespace
// writes) — meshAnnounce.ts's signature verification, specifically. Kept
// here rather than duplicated so the two never quietly drift apart.
export function toStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toStableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${toStableJson(obj[k])}`).join(",")}}`;
}

export function decodeSignature(rawSignature: string): Buffer | null {
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

export function verifySignature(publicKey: string, message: string, signature: Buffer): boolean {
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

/**
 * The exact path a write of this body targets -- checks a nested
 * `body.payload.path` before falling back to the OUTER `body.expression`,
 * matching normalizeLegacyReplayMemory()'s own resolution precisely (it now
 * calls this function directly, rather than duplicating the logic).
 *
 * Reserved-path guards (commandHandler.ts's keychain, gateway-authority, and
 * netget reserved-path checks) MUST read the path this same way. Reading it differently
 * -- e.g. only checking the outer `body.path`/`body.expression`, ignoring a
 * nested `payload` object -- lets a caller shape a request that passes the
 * guard while still writing to the reserved location, since this function
 * (via normalizeLegacyReplayMemory) resolves the ACTUAL write target
 * independently of whatever the guard checked. One shared function, used by
 * every guard and the writer, makes that divergence structurally
 * impossible instead of an easy-to-violate "keep two copies in sync"
 * obligation. Confirmed as a real (not hypothetical) bypass before this fix:
 * `{ payload: { path: "netget.delegates", value } }` read `path: undefined,
 * expression: undefined` under the old body.path||body.expression guard
 * logic, while this function (and the real writer) read
 * `netget.delegates` from the nested payload.
 */
export function extractLegacyWritePath(body: unknown): string {
  if (!isPlainObject(body)) return "";
  const record = body as Record<string, unknown>;
  const source = isPlainObject(record.payload) ? (record.payload as Record<string, unknown>) : record;
  return String(
    (typeof source.path === "string" && source.path) ||
      (typeof record.expression === "string" && record.expression) ||
      "",
  ).trim();
}

/**
 * The single, shared slash/dot canonicalization every reserved-path guard
 * must use before comparing a caller-supplied path -- kernelWrite()
 * (memoryStore.ts) treats "." and "/" as equivalent separators
 * (kpath.split(".").join("/") before the write ever reaches the kernel), so
 * "netget.delegates" and a literal "netget/delegates" land on the identical
 * physical location. A guard comparing the raw, un-normalized path misses
 * the slash form entirely -- confirmed as a real bypass before this was
 * applied consistently (netgetReservedPathAuthorization.test.ts). Every
 * guard in commandHandler.ts and syncHandler.ts must call this on a path
 * before checking it, not maintain its own copy of the same three-line
 * transform -- that duplication is exactly how syncHandler.ts's per-event
 * checks went unnormalized for a full review cycle after
 * rootCommandHandler's own guards were already fixed.
 */
export function canonicalizeWritePath(pathInput: string): string {
  return String(pathInput || "")
    .trim()
    .replace(/\//g, ".")
    .split(".")
    .filter(Boolean)
    .join(".");
}

/**
 * True when the RAW path (before canonicalizeWritePath's own
 * split-then-filter-then-join) is shaped in a way no guard here should
 * silently normalize away. Checked on the raw string deliberately, not the
 * canonicalized one: canonicalizeWritePath's `.filter(Boolean)` drops empty
 * segments (from "..", "//", a leading/trailing separator) before a guard
 * ever sees them, but the actual write path -- memoryStore.ts's
 * kernelWrite(), `kpath.split(".").join("/")` -- has no such filter, so
 * whatever the underlying `.me` kernel's own me:// URI parsing does with a
 * resulting empty segment (e.g. a literal "//" in the URI) is unverified
 * here, not confirmed safe. Rejecting the shape outright, before either
 * transform runs, closes that regardless of how it turns out to parse
 * downstream. Also rejects a "scheme://" prefix (a caller-supplied "me://"
 * URI has no business appearing as a bare path value) and a percent-encoded
 * segment (this codebase's own paths are plain ASCII dotted segments; an
 * encoded one is exactly the shape that reads one way to a guard's string
 * comparison and could decode to another by the time something else parses
 * it). Checked in addition to, not instead of, the specific reserved-path
 * guards -- this is a blanket shape rejection, not a replacement for any of
 * them.
 */
export function isMalformedWritePath(rawPath: string): boolean {
  const p = String(rawPath || "");
  if (!p.trim()) return false; // empty is a different, already-handled case
  if (p.includes("://")) return true;
  if (/%[0-9a-fA-F]{2}/.test(p)) return true;
  // Any run of 2+ separator characters (mixed "." and "/") produces an
  // empty segment once split -- ".." itself is exactly this shape (two
  // separators with nothing between). Also rejects a leading or trailing
  // separator for the same reason (an empty first/last segment).
  if (/[./]{2,}/.test(p)) return true;
  if (/^[./]|[./]$/.test(p.trim())) return true;
  return false;
}

function normalizeLegacyReplayMemory(input: unknown): ReplayMemory | null {
  if (!isPlainObject(input)) return null;

  const source = isPlainObject(input.payload) ? input.payload : input;
  const path = extractLegacyWritePath(input);
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

/**
 * The current chain head for a namespace's memory sequence -- the hash a
 * signer must bind into a write's signed payload (Surface-Identity-Claims.md
 * §7.7's anti-replay fix) so the server can reject any write whose signature
 * was computed against a state that has since moved. The signature itself
 * still only ever proves "the claim holder authorized This Exact body" --
 * this is what turns that into "authorized it for THIS namespace, at THIS
 * moment", closing both a same-namespace replay (a stale signed grant
 * silently un-revoking a delegate) and a cross-namespace replay (the same
 * key, claiming two namespaces, replaying a write meant for one against the
 * other -- nothing in the signed body itself bound it to either before this).
 *
 * The empty-chain case (no writes yet) deliberately does NOT return a fixed
 * constant (e.g. ""): a fixed initial head would let the very FIRST signed
 * write for a namespace be replayed after that namespace's state resets back
 * to empty (a legitimate scenario -- re-claiming after data loss, or a test
 * fixture). Binding it to the claim's own identityHash AND createdAt means a
 * re-claim by the very same identity still produces a fresh initial head,
 * since createdAt is set fresh at claim time.
 */
// Operational/telemetry writes (hostTelemetryLedger.ts's surface.host.*,
// usageLedger.ts's surface.usage.*) land under this namespace's own memory
// sequence whenever this namespace happens to BE the monad's own self
// identity (a real, common case -- e.g. a surface claiming its own
// namespace per Surface-Identity-Claims.md §7.3), and both fire on an
// interval/per-request basis, independent of anything a real client
// actually wrote. Confirmed live: excluding this before computing the
// chain head is not defensive-only -- without it, a legitimate claimed
// write for the monad's own root namespace failed with a spurious
// STALE_HEAD whenever a queued usage/telemetry write landed between the
// client's read of the head and its signed write reaching the server,
// which a request-per-second usage ledger makes near-certain, not rare.
const CHAIN_HEAD_EXCLUDED_PREFIX = "surface.";

export function getNamespaceChainHead(
  namespace: string,
  claim: { identityHash: string; createdAt: number },
): string {
  const memories = getMemoriesForNamespace(namespace).filter(
    (memory) => !String(memory.path || "").startsWith(CHAIN_HEAD_EXCLUDED_PREFIX),
  );
  const last = memories[memories.length - 1];
  if (last?.hash) return last.hash;
  return crypto
    .createHash("sha256")
    .update(`genesis:${claim.identityHash}:${claim.createdAt}`)
    .digest("hex");
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

  // signedPayload is an optional client-supplied convenience — the exact
  // string the client's own signer serialized and signed, so it doesn't
  // have to trust its own JSON stringification matches this server's
  // toStableJson() byte-for-byte. But a signature only proves possession of
  // the private key for WHATEVER string it verifies against — if that
  // string is just taken from the client at face value, a caller can sign
  // an innocuous payload once and replay that valid signature next to an
  // entirely different, unsigned real body ("sign A, send B"). The
  // signature is only meaningful authorization for THIS write if the
  // signed string is independently confirmed to equal the canonical form
  // of the body actually being committed — never trusted as given.
  const canonicalBody = toStableJson(stripWriteAuthFields(bodyRecord));
  const signedPayload = String(bodyRecord.signedPayload || "").trim();
  if (signedPayload && signedPayload !== canonicalBody) return false;
  return verifySignature(publicKey, canonicalBody, signature);
}
