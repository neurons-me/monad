import express from "express";
import {
  deleteMonadProcess,
  getMonadStatus,
  listMonadRecords,
  normalizeMonadName,
  pauseMonadProcess,
  readLogTail,
  readMonadRecord,
  restartMonadProcess,
  resumeMonadProcess,
  startExistingMonadProcess,
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
  // Absent entirely (no Origin header at all -- a non-browser caller, or a
  // same-origin request, neither of which sends one) is the only case this
  // treats as "nothing to check." The literal string "null" is a REAL,
  // attacker-controlled Origin value, not an absence of one: a sandboxed
  // iframe (<iframe sandbox src="data:text/html,...">) or a data:/file: page
  // sends exactly `Origin: null` by spec, specifically because it has no
  // origin of its own to disclose -- and used to pass this check for that
  // reason, found live 2026-10-04 (same audit pass that closed the
  // equivalent loopback-only/CORS-reflection gaps in netget): a page with no
  // real origin to lose could embed a sandboxed iframe whose script reaches
  // this control plane (start/stop/restart/delete named monad processes)
  // with Origin: null and sailed through. There is no legitimate first-party
  // caller that needs this exemption -- this monad's own UI is same-origin,
  // which sends either no Origin header or the real matching one, never the
  // literal string "null".
  if (!origin) return true;
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

/**
 * HTTP orders are closed (typedocs/Mesh/monad-control-orders.md §6, D10 option a, approved 2026-11-17).
 *
 * The guard above decides from `Host` and `Origin`, headers the caller writes, so it cannot authorize an order.
 * Until orders are signed through .me (that contract's §3), every request under /__monads that is not a read is
 * refused here, whatever its path, method or headers -- including the older aliases (`stop`, `start`, `resume`,
 * `POST /:name/delete`, `DELETE /:name`) and any route added later. Reads (list, status, logs) stay. The CLI is
 * unaffected: it acts on the files, not over HTTP.
 */
export const ORDERS_DISABLED = "ORDERS_DISABLED";
export const ORDERS_DISABLED_MESSAGE =
  "Monad orders over HTTP are closed until they are signed through .me. Use the monads CLI on this machine.";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuseHttpOrders(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (READ_METHODS.has(req.method.toUpperCase())) return next();
  return res.status(403).json({ ok: false, error: ORDERS_DISABLED, message: ORDERS_DISABLED_MESSAGE });
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

// Orders are advertised as CLI-only (method "CLI", no path), the same convention `proxy` already uses, so a client
// renders them unavailable from the web instead of calling a route that refuses them.
const ORDER_ACTIONS = new Set(["start", "on", "resume", "pause", "off", "stop", "restart", "delete"]);

function monadsCommandPayload() {
  return {
    name: "monads",
    available: true,
    install: "npm install -g monad.ai",
    start: "monads start",
    orders: { enabled: false, error: ORDERS_DISABLED, message: ORDERS_DISABLED_MESSAGE },
    actions: monadsActions().map((action) =>
      ORDER_ACTIONS.has(action.name) ? { ...action, method: "CLI", path: "" } : action),
  };
}

function monadsActions() {
  return [
    { name: "list", label: "List", command: "monads list", method: "GET", path: "/__monads", scope: "registry" },
    { name: "start", label: "Start New", command: "monads start [name]", method: "POST", path: "/__monads/start", scope: "registry" },
    { name: "on", label: "On", command: "monads on <name>", method: "POST", path: "/__monads/:name/on", scope: "monad" },
    { name: "resume", label: "Resume", command: "monads resume <name>", method: "POST", path: "/__monads/:name/resume", scope: "monad" },
    { name: "pause", label: "Pause", command: "monads pause <name>", method: "POST", path: "/__monads/:name/pause", scope: "monad" },
    { name: "off", label: "Off", command: "monads off <name>", method: "POST", path: "/__monads/:name/off", scope: "monad" },
    { name: "stop", label: "Stop", command: "monads stop <name>", method: "POST", path: "/__monads/:name/stop", scope: "monad" },
    { name: "restart", label: "Restart", command: "monads restart <name>", method: "POST", path: "/__monads/:name/restart", scope: "monad" },
    { name: "delete", label: "Delete", command: "monads delete <name>", method: "POST", path: "/__monads/:name/delete", scope: "monad" },
    { name: "status", label: "Status", command: "monads status <name>", method: "GET", path: "/__monads/:name/status", scope: "monad" },
    { name: "logs", label: "Logs", command: "monads logs <name> --tail", method: "GET", path: "/__monads/:name/logs", scope: "monad" },
    { name: "proxy", label: "Proxy", command: "monads proxy", method: "CLI", path: "", scope: "gateway" },
  ];
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("INVALID_PORT");
  }
  return port;
}

function parseNamespace(value: unknown): string | undefined {
  return readString(value);
}

function controlActionErrorStatus(error: any): number {
  const message = error?.message || String(error);
  if (message === "INVALID_PORT") return 400;
  if (message.includes("was not found")) return 404;
  return 409;
}

export function createMonadsControlRouter(): express.Router {
  const router = express.Router();
  // Guard applies only to /__monads control plane routes.
  // Public namespace/data routes must pass through freely.
  // First, before the header-based guard: every order is refused the same way, whatever headers it carries, on all
  // routes below, present and future (see refuseHttpOrders).
  router.use('/__monads', refuseHttpOrders);
  router.use('/__monads', localControlGuard);

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
        namespace: parseNamespace(req.body?.namespace ?? req.body?.rootspace),
      });
      return res.status(201).json({
        ok: true,
        command: monadsCommandPayload(),
        monad: serializeStatus(status),
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: message });
    }
  });

  router.post("/__monads/:name/start", async (req, res) => {
    try {
      const status = await startExistingMonadProcess(req.params.name, {
        port: parsePort(req.body?.port),
        namespace: parseNamespace(req.body?.namespace ?? req.body?.rootspace),
      });
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/on", async (req, res) => {
    try {
      const status = await resumeMonadProcess(req.params.name, {
        port: parsePort(req.body?.port),
        namespace: parseNamespace(req.body?.namespace ?? req.body?.rootspace),
      });
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/resume", async (req, res) => {
    try {
      const status = await resumeMonadProcess(req.params.name, {
        port: parsePort(req.body?.port),
        namespace: parseNamespace(req.body?.namespace ?? req.body?.rootspace),
      });
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/pause", async (req, res) => {
    try {
      const status = await pauseMonadProcess(req.params.name);
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/off", async (req, res) => {
    try {
      const status = await stopMonadProcess(req.params.name);
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/restart", async (req, res) => {
    try {
      const status = await restartMonadProcess(req.params.name, {
        port: parsePort(req.body?.port),
        namespace: parseNamespace(req.body?.namespace ?? req.body?.rootspace),
      });
      return res.json({ ok: true, command: monadsCommandPayload(), monad: serializeStatus(status) });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.post("/__monads/:name/delete", async (req, res) => {
    try {
      const result = await deleteMonadProcess(req.params.name);
      return res.json({
        ok: true,
        command: monadsCommandPayload(),
        monad: {
          name: result.record.name,
          deleted: true,
          runtimeDir: result.runtimeDir,
        },
      });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.delete("/__monads/:name", async (req, res) => {
    try {
      const result = await deleteMonadProcess(req.params.name);
      return res.json({
        ok: true,
        command: monadsCommandPayload(),
        monad: {
          name: result.record.name,
          deleted: true,
          runtimeDir: result.runtimeDir,
        },
      });
    } catch (error: any) {
      return res.status(controlActionErrorStatus(error)).json({ ok: false, error: error?.message || String(error) });
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
