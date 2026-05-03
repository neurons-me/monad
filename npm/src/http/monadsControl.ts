import express from "express";
import {
  getMonadStatus,
  listMonadRecords,
  normalizeMonadName,
  readLogTail,
  readMonadRecord,
  startMonadProcess,
  stopMonadProcess,
  type MonadRuntimeStatus,
} from "../cli/runtime.js";

function hostLabel(value: string | undefined): string {
  const raw = String(value || "").trim().split(",")[0] || "";
  const withoutProtocol = raw.replace(/^[a-z]+:\/\//i, "");
  const withoutAuth = withoutProtocol.includes("@") ? withoutProtocol.split("@").pop() || "" : withoutProtocol;
  return withoutAuth.replace(/^\[|\]$/g, "").split(":")[0]?.toLowerCase() || "";
}

function isLocalControlHost(value: string | undefined): boolean {
  const host = hostLabel(value);
  return (
    host === "" ||
    host === "localhost" ||
    host === "local.monad" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function isAllowedOrigin(req: express.Request): boolean {
  const origin = req.get("origin");
  if (!origin || origin === "null") return true;
  return isLocalControlHost(origin);
}

function localControlGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isLocalControlHost(req.get("host")) && isAllowedOrigin(req)) return next();
  return res.status(403).json({
    ok: false,
    error: "LOCAL_MONADS_CONTROL_ONLY",
    message: "Monad process control is only available from a local monad surface.",
  });
}

function serializeStatus(status: MonadRuntimeStatus) {
  return {
    name: status.record.name,
    port: status.record.port,
    status: status.status === "running" ? "online" : status.status,
    namespace: status.record.namespace,
    endpoint: status.record.endpoint,
    pid: status.record.pid,
    healthy: status.healthy,
    pidAlive: status.pidAlive,
    error: status.error || "",
    surface: status.record.surface,
    startedAt: status.record.startedAt,
    updatedAt: status.record.updatedAt,
  };
}

async function listStatuses() {
  return Promise.all((await listMonadRecords()).map(getMonadStatus));
}

function monadsCommandPayload() {
  return {
    name: "monads",
    available: true,
    install: "npm install -g monad.ai",
    start: "monads start",
  };
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("INVALID_PORT");
  }
  return port;
}

export function createMonadsControlRouter(): express.Router {
  const router = express.Router();
  router.use(localControlGuard);

  router.get("/__monads", async (_req, res) => {
    const statuses = await listStatuses();
    return res.json({
      ok: true,
      command: monadsCommandPayload(),
      monads: statuses.map(serializeStatus),
    });
  });

  router.post("/__monads/start", async (req, res) => {
    try {
      const status = await startMonadProcess({
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        port: parsePort(req.body?.port),
      });
      return res.status(201).json({
        ok: true,
        command: monadsCommandPayload(),
        monad: serializeStatus(status),
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      return res.status(message === "INVALID_PORT" ? 400 : 409).json({ ok: false, error: message });
    }
  });

  router.get("/__monads/:name/status", async (req, res) => {
    const name = normalizeMonadName(req.params.name);
    const record = await readMonadRecord(name);
    if (!record) return res.status(404).json({ ok: false, error: "MONAD_NOT_FOUND" });
    const status = await getMonadStatus(record);
    return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
  });

  router.get("/__monads/:name/logs", async (req, res) => {
    const name = normalizeMonadName(req.params.name);
    const record = await readMonadRecord(name);
    if (!record) return res.status(404).json({ ok: false, error: "MONAD_NOT_FOUND" });
    const lines = Math.min(240, Math.max(10, Number(req.query.lines || 80) || 80));
    const stdout = await readLogTail(record, "stdout", lines);
    const stderr = await readLogTail(record, "stderr", lines);
    return res.json({
      ok: true,
      command: monadsCommandPayload(),
      monad: {
        name: record.name,
        stdout,
        stderr,
        stdoutLog: record.stdoutLog,
        stderrLog: record.stderrLog,
      },
    });
  });

  router.post("/__monads/:name/stop", async (req, res) => {
    try {
      const status = await stopMonadProcess(req.params.name);
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(404).json({ ok: false, error: error?.message || String(error) });
    }
  });

  return router;
}
