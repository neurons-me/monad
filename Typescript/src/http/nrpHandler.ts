import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { getKernel } from "../kernel/manager.js";
import { resolveNamespacePathValue, type ResolvedNamespacePath } from "./pathResolver.js";
import { resolveServedNamespace } from "./requestedNamespace.js";
import { subscribe as subscribePathChange } from "../kernel/pathNotify.js";
import type { DisclosureContent } from "./disclosure.js";
import { isValidDomainShape } from "cleaker";

// Internal classification only — never sent on the wire. "stealth" means the
// kernel would not confirm existence of the path (A0/A2 axioms); per NRP
// Section 6 that's indistinguishable from "closed" to an observer, so
// toWireDisclosure() collapses it before anything reaches the client, the
// same way pathResolver.ts's toDisclosureContent() does for HTTP.
type InternalClassification = "public" | "stealth" | "closed";

function toWireDisclosure(classification: InternalClassification): DisclosureContent {
  if (classification === "public") return "public";
  return "closed";
}

type MsgNrpOpen = {
  type: "nrp.open";
  expression: string;
  canonical: string;
  ast: unknown;
  client?: { surface?: string; userAgent?: string; gui?: string };
  timestamp?: number;
};

type MsgResolved = {
  type: "resolved";
  channelId: string;
  payload: {
    endpoints: string[];
    audience?: string[];
    capabilities?: string[];
    surface?: string;
    disclosure: DisclosureContent;
  };
  timestamp: number;
};

// code is present only for the domain-shape gate below — see
// Beatle.types.ts's MsgError doc comment (this is the mirrored copy).
type MsgError = { type: "error"; channelId?: string; payload: string; code?: "invalid_namespace_shape"; timestamp: number };
type MsgPong  = { type: "pong"; timestamp: number };

// Client → server: read the current value, or subscribe/unsubscribe to live
// updates, at a semantic path — mirrors this.gui's Beatle.types.ts MsgRead/
// MsgSubscribe/MsgUnsubscribe (same shape, kept as a local copy here since
// this package doesn't depend on this.gui).
type MsgReadOrSubscribe = {
  type: "read" | "subscribe" | "unsubscribe";
  channelId?: string;
  namespace: string;
  path: string;
  timestamp?: number;
};

type PathDataPayload = { path: string; value: unknown; disclosure: DisclosureContent };

// Server → client: reply to 'read'/'subscribe' (current value) or a live
// update pushed for a 'subscribe'd path (payload shape is the same either
// way — see Beatle.types.ts's MsgData/MsgStream).
type MsgData = { type: "data"; channelId?: string; payload: PathDataPayload; timestamp: number };
type MsgStream = { type: "stream"; channelId?: string; payload: PathDataPayload; timestamp: number };

function send(ws: WebSocket, msg: MsgResolved | MsgError | MsgPong | MsgData | MsgStream): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// "not_found" isn't a disclosure value on the wire (matches pathResolver.ts's
// HTTP behavior, which 404s instead) — read/subscribe reply with an 'error'
// message for that case rather than folding it into MsgData.
function toPathDisclosure(resolved: ResolvedNamespacePath): DisclosureContent | null {
  if (resolved._classification === "not_found") return null;
  return resolved._classification === "public" ? "public" : "closed";
}

function classifyNamespace(namespace: string): InternalClassification {
  try {
    const kernel = getKernel();
    // Walk the namespace path and check disclosure using the kernel's
    // secret-scope rules. Path format: "users.<handle>" for personal namespaces.
    const segments = namespace.split(".").filter(Boolean);
    const value = (kernel as any).read?.(segments) ?? (kernel as any).get?.(segments);
    if (value === undefined) return "stealth";
    return "public";
  } catch {
    return "closed";
  }
}

// Structural mirror of this.gui's NRPNode (NRPExpression.ts) — duck-typed,
// not imported, since this package deliberately doesn't depend on this.gui
// (see MsgNrpOpen's own header comment). Client is intent/hint only, never
// trusted as authoritative: this just decides WHICH single token to
// domain-shape-check and classify, it never skips that check for whatever
// it finds.
type WireNsNode = {
  kind?: string;
  value?: string;
  parsed?: { fqdn?: string };
  namespace?: WireNsNode;
  operand?: WireNsNode;
};

// A bare (non-me://) expression's canonical string is the WHOLE algebra
// expression — "local.cleaker @ facebook.com", "a + b" — not a namespace by
// itself. Before this, the whole string was checked (and classified)
// as-is, which meant any composite expression (overlay, union,
// intersection) could never pass the domain-shape gate even when its own
// namespace leaf was perfectly valid — not because that leaf was wrong, but
// because the extraction never separated it from the rest of the algebra.
// This finds the one namespace leaf this server can actually still act on
// (overlay/complement unwrap to their single operand; union/intersection
// have no single leaf to prefer, per SetChemistry.findings.md's own
// per-operator table, so those fall back to the raw string exactly as
// before). Composite algebra otherwise stays exactly as unresolved as
// SetChemistry.findings.md already documents — this does not add real `@`/
// `+`/`∩` resolution, it only fixes what gets shape-checked and classified
// for the overlay/complement case.
function extractNamespaceHint(ast: unknown): string | null {
  const node = ast as WireNsNode | null | undefined;
  if (!node || typeof node !== "object") return null;
  if (node.kind === "namespace") return node.parsed?.fqdn || node.value || null;
  if (node.kind === "overlay") return extractNamespaceHint(node.namespace);
  if (node.kind === "complement") return extractNamespaceHint(node.operand);
  return null;
}

function deriveEndpoints(namespace: string, req: IncomingMessage): string[] {
  const host = req.headers["x-forwarded-host"] as string
    || req.headers["host"]
    || "localhost";
  // Strip port from host for clean URL building
  const cleanHost = host.split(":")[0];
  return [`https://${cleanHost}/${namespace}`];
}

function handleNrpOpen(ws: WebSocket, req: IncomingMessage, msg: MsgNrpOpen): void {
  const channelId = randomUUID();

  // Extract the namespace from the canonical form or raw expression.
  // canonical: "me://namespace/expression" or bare "expression"
  let namespace = "";
  const canonical = String(msg.canonical || msg.expression || "");
  if (canonical.startsWith("me://")) {
    const withoutScheme = canonical.slice(5);
    // namespace is everything up to the first "/" after the scheme
    const slashIdx = withoutScheme.indexOf("/");
    namespace = slashIdx >= 0 ? withoutScheme.slice(0, slashIdx) : withoutScheme;
    // Strip optional monad selector [...]
    const bracketIdx = namespace.indexOf("[");
    if (bracketIdx >= 0) namespace = namespace.slice(0, bracketIdx);
  } else {
    // Bare expression — no me:// namespace context in the string itself.
    // Try the client's ast hint for the one namespace leaf this server can
    // act on (see extractNamespaceHint's own doc comment); fall back to the
    // raw string for the cases that hint can't resolve a single leaf for
    // (plain namespace with no ast, or union/intersection with two).
    namespace = extractNamespaceHint(msg.ast) || canonical;
  }

  // Server has semantic authority (see this file's own header comment on
  // MsgNrpOpen) — re-check domain shape here even though useBeatle.ts already
  // gates this client-side before ever opening a socket. A namespace can
  // still be a real claim/branch in `.me` without this passing (the kernel
  // has always treated namespace as an opaque string); it simply never
  // derives an NRP channel, so this rejects before doing any kernel lookup.
  if (!isValidDomainShape(namespace)) {
    send(ws, {
      type: "error",
      channelId,
      payload: "invalid NRP - domain name",
      code: "invalid_namespace_shape",
      timestamp: Date.now(),
    });
    return;
  }

  const disclosure = toWireDisclosure(classifyNamespace(namespace));
  const endpoints  = deriveEndpoints(namespace, req);

  const resolved: MsgResolved = {
    type: "resolved",
    channelId,
    payload: {
      endpoints,
      disclosure,
      capabilities: ["read"],
    },
    timestamp: Date.now(),
  };
  send(ws, resolved);
}

// Per-connection live subscriptions: key is "<namespace>::<path>" so the
// same connection can subscribe to multiple paths (and multiple namespaces,
// though a single Beatle channel only ever opens one). Cleaned up on
// 'unsubscribe' and on connection close (see attachNrpWebSocketServer).
const connectionSubs = new WeakMap<WebSocket, Map<string, () => void>>();

function subKey(namespace: string, path: string): string {
  return `${namespace}::${path}`;
}

async function sendPathData(
  ws: WebSocket,
  type: "data" | "stream",
  channelId: string | undefined,
  namespace: string,
  path: string,
): Promise<void> {
  const resolved = await resolveNamespacePathValue(namespace, path);
  const disclosure = toPathDisclosure(resolved);
  if (disclosure === null) {
    send(ws, { type: "error", channelId, payload: "PATH_NOT_FOUND", timestamp: Date.now() });
    return;
  }
  send(ws, {
    type,
    channelId,
    payload: { path: resolved.path, value: resolved.found ? resolved.value : null, disclosure },
    timestamp: Date.now(),
  });
}

// The namespace a message names is resolved against the spaces this monad serves, as a host is: one it does
// not serve is refused. (It used to be passed through as a string, and a namespace this monad does not
// serve fell to the kernel root's storage under a name that was not the root's.)
function servedNamespaceOf(ws: WebSocket, msg: MsgReadOrSubscribe): string | null {
  const served = resolveServedNamespace(msg.namespace);
  if (served.ok) return served.namespace;
  send(ws, { type: "error", channelId: msg.channelId, payload: served.reason, timestamp: Date.now() });
  return null;
}

async function handleRead(ws: WebSocket, msg: MsgReadOrSubscribe): Promise<void> {
  const namespace = servedNamespaceOf(ws, msg);
  if (namespace === null) return;
  await sendPathData(ws, "data", msg.channelId, namespace, msg.path);
}

async function handleSubscribe(ws: WebSocket, msg: MsgReadOrSubscribe): Promise<void> {
  const requested = servedNamespaceOf(ws, msg);
  if (requested === null) return;
  msg = { ...msg, namespace: requested };
  const key = subKey(msg.namespace, msg.path);
  let subs = connectionSubs.get(ws);
  if (!subs) {
    subs = new Map();
    connectionSubs.set(ws, subs);
  }
  if (subs.has(key)) {
    // Already subscribed — just answer with the current value, don't double-register.
    await sendPathData(ws, "data", msg.channelId, msg.namespace, msg.path);
    return;
  }

  const unsubscribe = subscribePathChange(msg.namespace, msg.path, () => {
    void sendPathData(ws, "stream", msg.channelId, msg.namespace, msg.path);
  });
  subs.set(key, unsubscribe);

  await sendPathData(ws, "data", msg.channelId, msg.namespace, msg.path);
}

function handleUnsubscribe(ws: WebSocket, msg: MsgReadOrSubscribe): void {
  const served = resolveServedNamespace(msg.namespace);
  if (!served.ok) return;
  const key = subKey(served.namespace, msg.path);
  const subs = connectionSubs.get(ws);
  const unsubscribe = subs?.get(key);
  if (!unsubscribe) return;
  unsubscribe();
  subs!.delete(key);
}

function handleMessage(ws: WebSocket, req: IncomingMessage, raw: string): void {
  let msg: { type: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as { type: string } & Record<string, unknown>;
  } catch {
    send(ws, { type: "error", payload: "invalid JSON", timestamp: Date.now() });
    return;
  }

  switch (msg.type) {
    case "nrp.open":
      handleNrpOpen(ws, req, msg as unknown as MsgNrpOpen);
      break;
    case "read":
      void handleRead(ws, msg as unknown as MsgReadOrSubscribe);
      break;
    case "subscribe":
      void handleSubscribe(ws, msg as unknown as MsgReadOrSubscribe);
      break;
    case "unsubscribe":
      handleUnsubscribe(ws, msg as unknown as MsgReadOrSubscribe);
      break;
    case "ping":
      send(ws, { type: "pong", timestamp: Date.now() });
      break;
    default:
      // data / unknown — silently ignore for now
      break;
  }
}

/**
 * Attach the NRP WebSocket server to an existing HTTP server.
 * Beatle connects to ws[s]://<host>/nrp and sends `nrp.open` messages.
 */
export function attachNrpWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.url !== "/nrp") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    ws.on("message", (data) => handleMessage(ws, req, String(data)));
    ws.on("error", () => { /* ignore */ });
    ws.on("close", () => {
      const subs = connectionSubs.get(ws);
      if (!subs) return;
      subs.forEach((unsubscribe) => unsubscribe());
      connectionSubs.delete(ws);
    });
  });

  return wss;
}
