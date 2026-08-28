import os from "os";
import fs from "fs";
import { execSync } from "child_process";
import type express from "express";

export type SurfaceRequestEvent = {
  id: number;
  timestamp: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  host: string;
  namespace: string;
  operation: string;
  nrp: string;
  lens: string;
  forwardedHost: string | null;
  /** Ed25519 identity hash of the authenticated caller, when available. */
  identityHash: string | null;
};

export type SurfaceMemoryDetail = {
  /** How the ratio/pressure below were computed: real page-level accounting
   *  (macOS vm_stat, Linux /proc/meminfo MemAvailable) vs the naive
   *  (total-free)/total fallback, which reads misleadingly high on macOS —
   *  the OS deliberately fills "free" RAM with reclaimable disk cache. */
  source: "vm_stat" | "proc_meminfo" | "naive";
  /** GB actually pinned/in-use: wired + active + compressed (macOS) or
   *  MemTotal - MemAvailable (Linux) — the number that actually reflects
   *  memory pressure, not just "not instantly free." */
  usedGb: number;
  /** GB the OS can reclaim instantly if an app needs it (inactive +
   *  speculative + free on macOS, MemAvailable - MemFree on Linux). */
  reclaimableGb: number;
  /** macOS-only page breakdown, in GB, when source === "vm_stat". */
  breakdown?: {
    wired: number;
    active: number;
    compressed: number;
    inactive: number;
    speculative: number;
    free: number;
  };
};

export type SurfaceTelemetrySnapshot = {
  usage: {
    cpu: number;
    /** 0-1 fraction of RAM under real pressure — see memoryDetail.source
     *  for how this was computed; not simply (total-free)/total. */
    memory: number;
    /** 0-1 fraction of the root filesystem currently in use (fs.statfsSync("/")). */
    storage: number;
    requestRatePer10s: number;
  };
  memoryDetail: SurfaceMemoryDetail;
  pressure: {
    cpu: number;
  };
  policy: {
    gui: {
      blockchain: {
        limit: number;
      };
    };
  };
  budget: {
    gui: {
      blockchain: {
        rows: number;
      };
    };
  };
  monitor: {
    recentRequests: SurfaceRequestEvent[];
  };
};

type SurfaceRequestInput = Omit<SurfaceRequestEvent, "id" | "timestamp" | "identityHash"> & {
  timestamp?: number;
  identityHash?: string | null;
};

type SurfaceStreamClient = {
  id: number;
  res: express.Response;
};

const MAX_RECENT_REQUESTS = Math.max(20, Math.min(500, Number(process.env.MONAD_SURFACE_RECENT_REQUESTS || 120)));
const REQUEST_RATE_WINDOW_MS = Math.max(1_000, Math.min(60_000, Number(process.env.MONAD_SURFACE_RATE_WINDOW_MS || 10_000)));
const REQUEST_RATE_PRESSURE_THRESHOLD = Math.max(1, Number(process.env.MONAD_SURFACE_REQUEST_THRESHOLD || 40));
const SURFACE_POLICY_BLOCKCHAIN_LIMIT = Math.max(5, Number(process.env.MONAD_SURFACE_POLICY_GUI_BLOCKCHAIN_LIMIT || 80));
const SURFACE_BUDGET_BLOCKCHAIN_ROWS = Math.max(5, Number(process.env.MONAD_SURFACE_BUDGET_GUI_BLOCKCHAIN_ROWS || 50));
const SURFACE_STREAM_HEARTBEAT_MS = Math.max(1_000, Math.min(30_000, Number(process.env.MONAD_SURFACE_STREAM_HEARTBEAT_MS || 3_000)));

let nextRequestId = 1;
let nextClientId = 1;
const recentRequests: SurfaceRequestEvent[] = [];
const clients = new Set<SurfaceStreamClient>();

// ---------------------------------------------------------------------------
// Per-request listener registry
// ---------------------------------------------------------------------------

type SurfaceRequestListener = (event: SurfaceRequestEvent) => void;
const requestListeners: SurfaceRequestListener[] = [];

/**
 * Registers a callback that fires synchronously after every surface request is
 * recorded.  Returns an unsubscribe function.
 *
 * Listeners MUST NOT throw — exceptions are caught and silently discarded so
 * they can never break request-handling.  Kept in module scope (not per-server)
 * because `recordSurfaceRequest` is a module-level function.
 *
 * @example
 * ```typescript
 * const off = addSurfaceRequestListener(event => ledger.record(event));
 * // later:
 * off();
 * ```
 */
export function addSurfaceRequestListener(fn: SurfaceRequestListener): () => void {
  requestListeners.push(fn);
  return () => {
    const i = requestListeners.indexOf(fn);
    if (i !== -1) requestListeners.splice(i, 1);
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function computeCpuUsageRatio() {
  const cores = Math.max(1, os.cpus()?.length || 1);
  const load = Number(os.loadavg?.()[0] || 0);
  return clamp01(load / cores);
}

function naiveMemoryDetail(): SurfaceMemoryDetail {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    source: "naive",
    usedGb: Math.max(0, (total - free) / 1e9),
    reclaimableGb: Math.max(0, free / 1e9),
  };
}

// macOS deliberately fills "free" RAM with reclaimable disk cache (inactive
// pages), so os.freemem() alone reads misleadingly high-pressure on a
// perfectly healthy machine — this is why the naive (total-free)/total
// ratio showed 98%+ even at rest. vm_stat's own page categories are what
// Activity Monitor's "Memory Pressure" is actually built from: wired
// (can't be paged out) + active (in current use) + compressed (already
// pressured, being kept small via compression) is real usage; inactive +
// speculative + free is what the OS can hand to a new process instantly.
function parseVmStatMemoryDetail(): SurfaceMemoryDetail | null {
  try {
    const raw = execSync("vm_stat", { timeout: 2000 }).toString("utf8");
    const pageSizeMatch = raw.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

    const pages = (label: string): number => {
      const match = raw.match(new RegExp(`Pages ${label}:\\s+(\\d+)\\.`));
      return match ? Number(match[1]) : 0;
    };

    const toGb = (count: number) => (count * pageSize) / 1e9;

    const free = toGb(pages("free"));
    const active = toGb(pages("active"));
    const inactive = toGb(pages("inactive"));
    const speculative = toGb(pages("speculative"));
    const wired = toGb(pages("wired down"));
    const compressed = toGb(pages("occupied by compressor"));

    const usedGb = wired + active + compressed;
    const reclaimableGb = free + inactive + speculative;
    if (usedGb + reclaimableGb <= 0) return null;

    return {
      source: "vm_stat",
      usedGb,
      reclaimableGb,
      breakdown: { wired, active, compressed, inactive, speculative, free },
    };
  } catch {
    return null;
  }
}

// Linux's kernel already computes "available" correctly (accounts for
// reclaimable page cache/slab, unlike a naive MemFree read) — MemAvailable
// has existed in /proc/meminfo since kernel 3.14, no need to hand-roll it.
function parseProcMeminfoMemoryDetail(): SurfaceMemoryDetail | null {
  try {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (label: string): number | null => {
      const match = raw.match(new RegExp(`^${label}:\\s+(\\d+) kB`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };

    const total = kb("MemTotal");
    const available = kb("MemAvailable");
    if (total == null || available == null || total <= 0) return null;

    return {
      source: "proc_meminfo",
      usedGb: Math.max(0, (total - available) / 1e9),
      reclaimableGb: Math.max(0, available / 1e9),
    };
  } catch {
    return null;
  }
}

function computeMemoryDetail(): SurfaceMemoryDetail {
  if (process.platform === "darwin") {
    return parseVmStatMemoryDetail() ?? naiveMemoryDetail();
  }
  if (process.platform === "linux") {
    return parseProcMeminfoMemoryDetail() ?? naiveMemoryDetail();
  }
  return naiveMemoryDetail();
}

function computeMemoryUsageRatio(detail: SurfaceMemoryDetail) {
  const total = detail.usedGb + detail.reclaimableGb;
  if (total <= 0) return 0;
  return clamp01(detail.usedGb / total);
}

function computeStorageUsageRatio() {
  try {
    const stats = fs.statfsSync("/");
    const totalBlocks = Number(stats.blocks);
    if (totalBlocks <= 0) return 0;
    const freeBlocks = Number(stats.bavail);
    return clamp01((totalBlocks - freeBlocks) / totalBlocks);
  } catch {
    return 0;
  }
}

function getRecentRequestRatePer10s(now: number) {
  const recent = recentRequests.filter((event) => now - event.timestamp <= REQUEST_RATE_WINDOW_MS);
  return recent.length;
}

function computeRequestPressure(now: number) {
  const rate = getRecentRequestRatePer10s(now);
  return clamp01(rate / REQUEST_RATE_PRESSURE_THRESHOLD);
}

export function getSurfaceTelemetrySnapshot(): SurfaceTelemetrySnapshot {
  const now = Date.now();
  const cpuUsage = computeCpuUsageRatio();
  const requestPressure = computeRequestPressure(now);
  const cpuPressure = Math.max(cpuUsage, requestPressure);
  const memoryDetail = computeMemoryDetail();

  return {
    usage: {
      cpu: cpuUsage,
      memory: computeMemoryUsageRatio(memoryDetail),
      storage: computeStorageUsageRatio(),
      requestRatePer10s: getRecentRequestRatePer10s(now),
    },
    memoryDetail,
    pressure: {
      cpu: cpuPressure,
    },
    policy: {
      gui: {
        blockchain: {
          limit: SURFACE_POLICY_BLOCKCHAIN_LIMIT,
        },
      },
    },
    budget: {
      gui: {
        blockchain: {
          rows: SURFACE_BUDGET_BLOCKCHAIN_ROWS,
        },
      },
    },
    monitor: {
      recentRequests: recentRequests.slice(0, MAX_RECENT_REQUESTS),
    },
  };
}

function writeSseEvent(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown) {
  for (const client of clients) {
    writeSseEvent(client.res, event, data);
  }
}

export function recordSurfaceRequest(input: SurfaceRequestInput) {
  const event: SurfaceRequestEvent = {
    id: nextRequestId++,
    timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
    method: String(input.method || "GET").trim().toUpperCase(),
    url: String(input.url || "").trim(),
    status: Number(input.status || 0) || 0,
    durationMs: Math.max(0, Number(input.durationMs || 0)),
    host: String(input.host || "").trim(),
    namespace: String(input.namespace || "").trim(),
    operation: String(input.operation || "").trim(),
    nrp: String(input.nrp || "").trim(),
    lens: String(input.lens || "").trim(),
    forwardedHost: input.forwardedHost ? String(input.forwardedHost).trim() : null,
    identityHash: input.identityHash ? String(input.identityHash).trim() : null,
  };

  recentRequests.unshift(event);
  if (recentRequests.length > MAX_RECENT_REQUESTS) {
    recentRequests.length = MAX_RECENT_REQUESTS;
  }

  broadcast("request", {
    request: event,
    telemetry: getSurfaceTelemetrySnapshot(),
  });

  // Notify registered listeners (e.g. ResourceUsageLedger).
  // Errors are swallowed — listeners must never affect request handling.
  for (const fn of requestListeners) {
    try { fn(event); } catch { /* intentionally ignored */ }
  }
}

export function attachSurfaceStreamClient(req: express.Request, res: express.Response) {
  const client: SurfaceStreamClient = {
    id: nextClientId++,
    res,
  };

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`retry: 2000\n\n`);

  clients.add(client);
  writeSseEvent(res, "surface", getSurfaceTelemetrySnapshot());

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    writeSseEvent(res, "surface", getSurfaceTelemetrySnapshot());
  }, SURFACE_STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };

  req.on("aborted", cleanup);
  req.on("close", cleanup);
  res.on("close", cleanup);
}
