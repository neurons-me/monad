import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { getKernel } from "../kernel/manager.js";
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

function send(ws: WebSocket, msg: MsgResolved | MsgError | MsgPong): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
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
  });

  return wss;
}
