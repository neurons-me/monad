import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { getKernel } from "../kernel/manager.js";
import { resolveNamespacePathValue, type ResolvedNamespacePath } from "./pathResolver.js";
import { subscribe as subscribePathChange } from "../kernel/pathNotify.js";
import type { DisclosureContent } from "./disclosure.js";

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

type MsgError = { type: "error"; channelId?: string; payload: string; timestamp: number };
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
    // Bare expression — no namespace context available from the expression alone
    namespace = canonical;
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

async function handleRead(ws: WebSocket, msg: MsgReadOrSubscribe): Promise<void> {
  await sendPathData(ws, "data", msg.channelId, msg.namespace, msg.path);
}

async function handleSubscribe(ws: WebSocket, msg: MsgReadOrSubscribe): Promise<void> {
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
  const key = subKey(msg.namespace, msg.path);
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
