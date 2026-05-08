import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeNamespaceConstant } from "../namespace/identity.js";

export type MonadRecordStatus = "starting" | "running" | "stopped" | "dead";

export interface MonadRecord {
  name: string;
  identity: string;
  namespace: string;
  surface: string;
  port: number;
  pid: number;
  endpoint: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  status: MonadRecordStatus;
  runtimeDir: string;
  stateDir: string;
  claimDir: string;
  selfConfigPath: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface StartMonadCliOptions {
  name?: string;
  port?: number;
  namespace?: string;
  cwd?: string;
  seed?: string;
}

export interface MonadRuntimeStatus {
  record: MonadRecord;
  pidAlive: boolean;
  healthy: boolean;
  status: MonadRecordStatus;
  surface?: unknown;
  error?: string;
}

export interface FollowMonadLogsOptions {
  lines?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  includeStderr?: boolean;
}

const DEFAULT_PORT_START = 8161;
const DEFAULT_PORT_END = 8999;

export function getMonadsHome(): string {
  return path.resolve(process.env.MONADS_HOME || path.join(os.homedir(), ".monad", "monads"));
}

export function normalizeMonadName(input?: string): string {
  const normalized = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || `monad-${Date.now().toString(36)}`;
}

function resolveDefaultRootspace(): string {
  return normalizeNamespaceConstant(
    process.env.MONAD_ROOTSPACE ||
      process.env.ME_NAMESPACE ||
      process.env.MONAD_SELF_IDENTITY ||
      process.env.MONAD_SELF_HOSTNAME ||
      os.hostname(),
  ) || "monad.local";
}

export function getMonadRuntimeDir(name: string): string {
  return path.join(getMonadsHome(), normalizeMonadName(name));
}

function getRecordPath(name: string): string {
  return path.join(getMonadRuntimeDir(name), "monad.json");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function findListeningPid(port: number): Promise<number | null | undefined> {
  if (!Number.isInteger(port) || port <= 0) return null;

  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (error, stdout) => {
      if (error) {
        resolve(error.code === 1 ? null : undefined);
        return;
      }

      const pid = Number(String(stdout || "").trim().split(/\s+/)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeRecord(record: MonadRecord): Promise<void> {
  await ensureDir(record.runtimeDir);
  await fsp.writeFile(getRecordPath(record.name), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function normalizeRecord(record: MonadRecord | null): MonadRecord | null {
  if (!record) return null;
  const legacyNameNamespace = normalizeNamespaceConstant(`${record.name}.local`);
  const recordedNamespace = normalizeNamespaceConstant(record.namespace || record.identity);
  const namespace = !record.namespace && recordedNamespace === legacyNameNamespace
    ? resolveDefaultRootspace()
    : normalizeNamespaceConstant(record.namespace || record.identity || resolveDefaultRootspace());
  return {
    ...record,
    namespace,
    identity: namespace,
    surface: record.surface || record.name,
  };
}

export async function readMonadRecord(name: string): Promise<MonadRecord | null> {
  return normalizeRecord(await readJsonFile<MonadRecord>(getRecordPath(name)));
}

export async function listMonadRecords(): Promise<MonadRecord[]> {
  const home = getMonadsHome();
  try {
    const entries = await fsp.readdir(home, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readMonadRecord(entry.name)),
    );

    return records
      .filter((record): record is MonadRecord => Boolean(record))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function listRunningMonads(): Promise<MonadRuntimeStatus[]> {
  const statuses = await Promise.all((await listMonadRecords()).map(getMonadStatus));
  return statuses.filter((status) => status.healthy && status.status === "running");
}

async function isPortFree(port: number): Promise<boolean> {
  const ownerPid = await findListeningPid(port);
  if (typeof ownerPid === "number") return false;

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findFreePort(preferred?: number): Promise<number> {
  if (preferred && await isPortFree(preferred)) return preferred;
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free Monad port found in ${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`);
}

function resolveServerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../server.js"),
    path.resolve(here, "../../server.ts"),
    path.resolve(here, "../../../server.ts"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Could not locate monad.ai server entry.");
  return found;
}

function resolvePackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../.."),
    path.resolve(here, "../.."),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  if (!found) throw new Error("Could not locate monad.ai package root.");
  return found;
}

function existingPath(...segments: string[]): string | undefined {
  const resolved = path.resolve(...segments);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function requestJson(url: string, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

async function waitForHealthy(endpoint: string, timeoutMs = 6000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await requestJson(`${endpoint}/__surface`, 750);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

export async function getMonadStatus(record: MonadRecord): Promise<MonadRuntimeStatus> {
  const alive = pidAlive(record.pid);
  if (!alive) {
    return {
      record,
      pidAlive: false,
      healthy: false,
      status: record.status === "stopped" ? "stopped" : "dead",
    };
  }

  const listenerPid = await findListeningPid(record.port);
  if (listenerPid === null) {
    return {
      record,
      pidAlive: true,
      healthy: false,
      status: record.status === "starting" ? "starting" : "dead",
      error: `Port ${record.port} is not listening.`,
    };
  }

  if (typeof listenerPid === "number" && listenerPid !== record.pid) {
    return {
      record,
      pidAlive: true,
      healthy: false,
      status: "dead",
      error: `Port ${record.port} is owned by PID ${listenerPid}, not PID ${record.pid}.`,
    };
  }

  try {
    const surface = await requestJson(`${record.endpoint}/__surface`, 1000);
    return {
      record,
      pidAlive: true,
      healthy: true,
      status: "running",
      surface,
    };
  } catch (error: any) {
    return {
      record,
      pidAlive: true,
      healthy: false,
      status: "starting",
      error: error?.message || String(error),
    };
  }
}

export async function startMonadProcess(options: StartMonadCliOptions = {}): Promise<MonadRuntimeStatus> {
  const name = normalizeMonadName(options.name);
  const existing = await readMonadRecord(name);
  if (existing && pidAlive(existing.pid)) {
    throw new Error(`Monad "${name}" is already running on port ${existing.port}.`);
  }

  const runtimeDir = getMonadRuntimeDir(name);
  const port = await findFreePort(options.port);
  const namespace = normalizeNamespaceConstant(options.namespace || resolveDefaultRootspace());
  const identity = namespace;
  const surface = name;
  const endpoint = `http://127.0.0.1:${port}`;
  const stateDir = path.join(runtimeDir, "state");
  const claimDir = path.join(runtimeDir, "claims");
  const selfConfigPath = path.join(runtimeDir, "self.json");
  const stdoutLog = path.join(runtimeDir, "stdout.log");
  const stderrLog = path.join(runtimeDir, "stderr.log");
  const packageRoot = resolvePackageRoot();
  const cwd = path.resolve(options.cwd || packageRoot);
  const now = new Date().toISOString();
  const repoRoot = path.resolve(packageRoot, "../../..");

  await ensureDir(runtimeDir);
  await ensureDir(stateDir);
  await ensureDir(claimDir);

  const out = fs.openSync(stdoutLog, "w");
  const err = fs.openSync(stderrLog, "w");
  const env = {
    ...process.env,
    PORT: String(port),
    SEED: options.seed || process.env.SEED || process.env.ME_SEED || `monad-local:${name}`,
    ME_NAMESPACE: namespace,
    ME_STATE_DIR: stateDir,
    MONAD_CLAIM_DIR: claimDir,
    MONAD_SELF_CONFIG_PATH: selfConfigPath,
    MONAD_SELF_IDENTITY: namespace,
    MONAD_SELF_HOSTNAME: namespace,
    MONAD_SELF_ENDPOINT: endpoint,
    MONAD_SELF_TAGS: `local,monad,${name},surface:${name}`,
    MONAD_NAME: name,
    MONAD_SURFACE: surface,
    MONAD_ROOTSPACE: namespace,
    MONAD_INDEX_PATH: existingPath(packageRoot, "../index.html"),
    MONAD_ROUTES_PATH: existingPath(packageRoot, "../routes.js"),
    GUI_PKG_DIST_DIR: existingPath(repoRoot, "packages/GUI/npm/dist"),
    ME_PKG_DIST_DIR: existingPath(repoRoot, "me/npm/dist"),
    CLEAKER_PKG_DIST_DIR: existingPath(packageRoot, "../../cleaker/npm/dist"),
    LOCAL_REACT_UMD_DIR: existingPath(repoRoot, "packages/GUI/npm/node_modules/react/umd"),
    LOCAL_REACTDOM_UMD_DIR: existingPath(repoRoot, "packages/GUI/npm/node_modules/react-dom/umd"),
  };

  const child = spawn(process.execPath, [resolveServerEntry()], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);

  const record: MonadRecord = {
    name,
    identity,
    namespace,
    surface,
    port,
    pid: child.pid || 0,
    endpoint,
    cwd,
    startedAt: now,
    updatedAt: now,
    status: "starting",
    runtimeDir,
    stateDir,
    claimDir,
    selfConfigPath,
    stdoutLog,
    stderrLog,
  };

  await writeRecord(record);
  const healthy = await waitForHealthy(endpoint);
  const updated = {
    ...record,
    status: healthy ? "running" as const : "starting" as const,
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(updated);
  return getMonadStatus(updated);
}

export async function stopMonadProcess(name: string): Promise<MonadRuntimeStatus> {
  const normalized = normalizeMonadName(name);
  const record = await readMonadRecord(normalized);
  if (!record) throw new Error(`Monad "${normalized}" was not found.`);

  if (pidAlive(record.pid)) {
    process.kill(record.pid, "SIGTERM");
    const started = Date.now();
    while (pidAlive(record.pid) && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const updated = {
    ...record,
    status: "stopped" as const,
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(updated);
  return getMonadStatus(updated);
}

export async function readLogTail(record: MonadRecord, stream: "stdout" | "stderr" = "stdout", lines = 80): Promise<string> {
  const logPath = stream === "stdout" ? record.stdoutLog : record.stderrLog;
  try {
    const content = await fsp.readFile(logPath, "utf8");
    return content.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}

async function printInitialTail(logPath: string, output: NodeJS.WritableStream, lines: number): Promise<number> {
  try {
    const content = await fsp.readFile(logPath, "utf8");
    const tail = content.split(/\r?\n/).slice(-lines).join("\n").trim();
    if (tail) {
      output.write(tail);
      if (!tail.endsWith("\n")) output.write("\n");
    }
    return Buffer.byteLength(content);
  } catch {
    return 0;
  }
}

function watchLogFile(input: {
  logPath: string;
  output: NodeJS.WritableStream;
  offset: number;
  intervalMs: number;
  signal?: AbortSignal;
}): NodeJS.Timeout {
  let offset = input.offset;
  let reading = false;

  const tick = async () => {
    if (reading || input.signal?.aborted) return;
    reading = true;
    try {
      const stat = await fsp.stat(input.logPath);
      if (stat.size < offset) offset = 0;
      if (stat.size > offset) {
        await new Promise<void>((resolve) => {
          const stream = fs.createReadStream(input.logPath, {
            start: offset,
            end: stat.size - 1,
            encoding: "utf8",
          });
          stream.on("data", (chunk) => input.output.write(chunk));
          stream.on("error", () => resolve());
          stream.on("end", () => resolve());
        });
        offset = stat.size;
      }
    } catch {
      // The log file may not exist yet during startup. Keep watching.
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(tick, input.intervalMs);
  void tick();
  return timer;
}

export interface StartMonadProxyOptions {
  port?: number;
}

function buildPacFile(proxyPort: number): string {
  return `function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, ".monad") || host === "local.monad") {
    return "PROXY 127.0.0.1:${proxyPort}";
  }
  return "DIRECT";
}`;
}

function buildStatusHtml(monads: MonadRuntimeStatus[], proxyPort: number): string {
  const rows = monads.length === 0
    ? `<tr><td colspan="4" style="color:#888;text-align:center">No monads running. Start one: <code>monads start &lt;name&gt;</code></td></tr>`
    : monads
        .map(
          (s) =>
            `<tr>
              <td><a href="http://${s.record.name}.monad" target="_blank">${s.record.name}.monad</a></td>
              <td><a href="${s.record.endpoint}" target="_blank">${s.record.endpoint}</a></td>
              <td style="font-size:0.9em;color:#555">${s.record.namespace}</td>
              <td style="color:#2a2">online</td>
            </tr>`,
        )
        .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Monads</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 10px; background: #f4f4f4; font-size: 0.85rem; }
  td { padding: 6px 10px; border-top: 1px solid #eee; font-size: 0.9rem; }
  a { color: #0070f3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .note { margin-top: 1.5rem; font-size: 0.85rem; color: #555; background: #fafafa; padding: 0.8rem 1rem; border-radius: 6px; }
  code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<h1>Monads</h1>
<table>
<thead><tr><th>URL</th><th>Endpoint</th><th>Namespace</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div class="note">
  <strong>local.monad</strong> → first running monad<br>
  <strong>name.monad</strong> → monad by name<br><br>
  PAC file: <code>http://127.0.0.1:${proxyPort}/proxy.pac</code>
</div>
</body>
</html>`;
}

export async function startMonadProxy(options: StartMonadProxyOptions = {}): Promise<void> {
  const proxyPort = options.port ?? 8160;

  const server = http.createServer(async (req, res) => {
    const hostRaw = String(req.headers.host || "").toLowerCase();
    const host = hostRaw.split(":")[0] ?? "";
    const url = req.url || "/";

    if (host === "127.0.0.1" || host === "localhost") {
      if (url === "/proxy.pac") {
        res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig" });
        res.end(buildPacFile(proxyPort));
        return;
      }
      const running = await listRunningMonads();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildStatusHtml(running, proxyPort));
      return;
    }

    const monadMatch = host.match(/^(.+)\.monad$/);
    if (!monadMatch) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Expected a *.monad host.");
      return;
    }

    const name = monadMatch[1];
    let targetPort: number | null = null;

    if (name === "local") {
      const running = await listRunningMonads();
      targetPort = running[0]?.record.port ?? null;
    } else if (name) {
      const record = await readMonadRecord(name);
      if (record && pidAlive(record.pid)) targetPort = record.port;
    }

    if (!targetPort) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<h2>Monad not found: ${name}</h2>` +
        `<p>Is <strong>${name}</strong> running? Try: <code>monads start ${name}</code></p>` +
        `<p><a href="http://127.0.0.1:${proxyPort}/">Dashboard</a></p>`,
      );
      return;
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Gateway error: ${err.message}`);
    });
    req.pipe(proxyReq, { end: true });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`Port ${proxyPort} is already in use. Try: monads proxy --port 8161\n`);
    } else {
      process.stderr.write(`Proxy error: ${err.message}\n`);
    }
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    server.listen(proxyPort, "127.0.0.1", () => {
      process.stdout.write(
        `\nMonad gateway running at http://127.0.0.1:${proxyPort}/\n` +
        `\nBrowser setup (one time):\n` +
        `  Safari / Chrome / Firefox proxy settings → Automatic proxy configuration:\n` +
        `  URL: http://127.0.0.1:${proxyPort}/proxy.pac\n` +
        `\nThen open:\n` +
        `  http://local.monad       → first running monad\n` +
        `  http://name.monad        → monad by name\n` +
        `\nPress Ctrl+C to stop.\n`,
      );
    });
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function followMonadLogs(record: MonadRecord, options: FollowMonadLogsOptions = {}): Promise<void> {
  const lines = options.lines || 80;
  const intervalMs = options.intervalMs || 250;
  const includeStderr = options.includeStderr !== false;

  const stdoutOffset = await printInitialTail(record.stdoutLog, process.stdout, lines);
  let stderrOffset = 0;
  if (includeStderr) {
    const stderr = await readLogTail(record, "stderr", lines);
    if (stderr) {
      process.stderr.write(`\n[stderr]\n${stderr}\n`);
      try {
        stderrOffset = (await fsp.stat(record.stderrLog)).size;
      } catch {
        stderrOffset = 0;
      }
    }
  }

  await new Promise<void>((resolve) => {
    const timers = [
      watchLogFile({
        logPath: record.stdoutLog,
        output: process.stdout,
        offset: stdoutOffset,
        intervalMs,
        signal: options.signal,
      }),
    ];

    if (includeStderr) {
      timers.push(watchLogFile({
        logPath: record.stderrLog,
        output: process.stderr,
        offset: stderrOffset,
        intervalMs,
        signal: options.signal,
      }));
    }

    const cleanup = () => {
      for (const timer of timers) clearInterval(timer);
      options.signal?.removeEventListener("abort", cleanup);
      resolve();
    };

    if (options.signal?.aborted) {
      cleanup();
      return;
    }
    options.signal?.addEventListener("abort", cleanup, { once: true });
  });
}
