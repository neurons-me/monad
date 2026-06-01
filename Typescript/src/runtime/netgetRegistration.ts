import crypto from "node:crypto";
import os from "node:os";
import type { MonadBootstrapResult, MonadLogger } from "../bootstrap.js";
import { resolveMeIdentityHash } from "../identity/meIdentity.js";

export interface MonadNetGetRegistration {
  id: string;
  endpoint: string;
  report(): Promise<void>;
  stop(): Promise<void>;
}

export type NetGetRegistrationPayload = {
  id: string;
  name: string;
  kind: "monad";
  pid: number;
  cwd: string;
  hostname: string;
  port: number;
  protocol: "http";
  host: string;
  url: string;
  tags: string[];
  metadata: Record<string, unknown>;
  status: "running";
  health: {
    state: "healthy";
    updatedAt: string;
    message?: string;
  };
  ui: {
    hasAdminPanel: boolean;
    hasUserPanel: boolean;
    defaultPath: string;
  };
  exposure: Record<string, unknown>;
  lifecycle: Record<string, boolean>;
  startedAt: string;
  updatedAt: string;
  ttlMs: number;
  mode: "fixed";
  portStatus: "active";
};

// Use 127.0.0.1 as default so monad registration works on any server
// without requiring local.netget to resolve. local.netget remains valid via NETGET_LOCAL.
const DEFAULT_NETGET_LOCAL = "http://127.0.0.1";
const LOCAL_NETGET_HOSTS = new Set(["local.netget", "localhost", "127.0.0.1", "[::1]", "::1"]);

function normalizeNetGetEndpoint(value?: string): string | null {
  const raw = String(value || process.env.NETGET_LOCAL || DEFAULT_NETGET_LOCAL).trim().replace(/\/+$/, "");
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!LOCAL_NETGET_HOSTS.has(url.hostname)) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeToken(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function listFromEnv(value: unknown): string[] {
  return String(value || "")
    .split(/[,\s]+/g)
    .map((item) => normalizeToken(item))
    .filter(Boolean);
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function postJson(endpoint: string, payload: unknown, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function buildNetGetMonadExposure(monadName: string) {
  const pathName = normalizeToken(monadName) || "default";
  return {
    enabled: true,
    visibility: "loopback",
    publishMode: "path",
    inbound: {
      allowHttp: true,
      allowHttps: false,
      allowWebsocket: true,
      bindHosts: ["local.netget", "localhost", "127.0.0.1"],
      paths: [`/monads/${pathName}`],
    },
    tls: {
      mode: "none",
      redirectHttpToHttps: false,
    },
    auth: {
      mode: "session",
      requiredForRead: false,
      requiredForControl: true,
      requiredForDestructive: true,
      rolesAllowed: ["admin"],
    },
    control: {
      read: true,
      control: true,
      destructive: false,
    },
    network: {
      allowLoopback: true,
      allowLan: false,
      allowWan: false,
      allowCidrs: [],
      denyCidrs: [],
      trustedProxies: [],
    },
    redirect: {
      additionalHosts: [],
      forceCanonicalHost: false,
    },
    headers: {
      forwardedHost: true,
      forwardedProto: true,
      forwardedFor: true,
      frameAncestors: ["'self'"],
    },
  };
}

export function buildNetGetMonadRegistrationPayload(input: {
  bootstrap: MonadBootstrapResult;
  id: string;
  startedAt: string;
  heartbeatMs: number;
}): NetGetRegistrationPayload | null {
  const { config } = input.bootstrap;
  const env = config.env || process.env;
  const port = Number(config.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const self = config.selfNodeConfig;
  const monadName = normalizeToken(
    env.MONAD_NAME ||
      self?.monadName ||
      self?.identity ||
      config.localNamespaceRoot ||
      `monad-${port}`,
  ) || `monad-${port}`;
  const host = normalizeToken(env.MONAD_NETGET_HOST) || "127.0.0.1";
  const url = `http://${host}:${port}`;
  const now = new Date().toISOString();
  const identityHash = resolveMeIdentityHash(env.SEED || env.ME_SEED);
  const aliases = unique([
    ...listFromEnv(env.MONAD_ALIASES),
    ...listFromEnv(env.MONAD_PUBLIC_HOSTS),
    normalizeToken(env.MONAD_PUBLIC_HOST),
    normalizeToken(env.NETGET_PUBLIC_HOST),
    normalizeToken(env.PUBLIC_HOST),
    normalizeToken(env.PUBLIC_DOMAIN),
  ]);
  const claimedNamespaces = unique([
    self?.identity,
    config.localNamespaceRoot,
    ...aliases,
  ]);
  const capabilities = unique([
    "surface",
    "gui",
    "control",
    "events",
    "mesh",
    ...(self?.resources || []),
  ]);
  const tags = unique([
    "monad",
    "surface",
    monadName,
    `surface:${monadName}`,
    ...(self?.tags || []),
  ]);

  return {
    id: input.id,
    name: `monad:${monadName}`,
    kind: "monad",
    pid: process.pid,
    cwd: config.cwd,
    hostname: os.hostname(),
    port,
    protocol: "http",
    host,
    url,
    tags,
    metadata: {
      title: self?.monadName || monadName,
      monadName,
      monadId: self?.monadId,
      identityHash,
      identity_hash: identityHash,
      namespace: self?.identity || config.localNamespaceRoot,
      identity: self?.identity,
      endpoint: url,
      directEndpoint: self?.endpoint,
      controlEndpoint: url,
      aliases,
      claimedNamespaces,
      claimed_namespaces: claimedNamespaces,
      defaultPath: "/",
      capabilities,
    },
    status: "running",
    health: {
      state: "healthy",
      updatedAt: now,
    },
    ui: {
      hasAdminPanel: true,
      hasUserPanel: true,
      defaultPath: "/",
    },
    exposure: buildNetGetMonadExposure(monadName),
    lifecycle: {
      supportsStart: true,
      supportsStop: true,
      supportsRestart: true,
      supportsPause: true,
      supportsResume: true,
      supportsDelete: true,
    },
    startedAt: input.startedAt,
    updatedAt: now,
    ttlMs: Math.max(input.heartbeatMs * 4, 12_000),
    mode: "fixed",
    portStatus: "active",
  };
}

export function startNetGetMonadRegistration(
  bootstrap: MonadBootstrapResult,
  logger: MonadLogger | null = null,
): MonadNetGetRegistration | null {
  if (process.env.MONAD_NETGET_DISABLED === "1" || process.env.MONAD_NETGET === "0") {
    return null;
  }

  const baseEndpoint = normalizeNetGetEndpoint();
  if (!baseEndpoint) return null;

  const heartbeatMs = Math.max(numberFromEnv("MONAD_NETGET_HEARTBEAT_MS", 3_000), 1_000);
  const timeoutMs = Math.max(numberFromEnv("MONAD_NETGET_TIMEOUT_MS", 800), 100);
  const startedAt = new Date().toISOString();
  const id = `monad:${crypto.randomUUID()}`;
  const reportEndpoint = `${baseEndpoint}/apps/report`;
  const releaseEndpoint = `${baseEndpoint}/apps/release`;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const registration: MonadNetGetRegistration = {
    id,
    endpoint: baseEndpoint,
    async report() {
      const payload = buildNetGetMonadRegistrationPayload({ bootstrap, id, startedAt, heartbeatMs });
      if (!payload) return;
      await postJson(reportEndpoint, payload, timeoutMs);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await postJson(releaseEndpoint, { id }, timeoutMs).catch(() => {});
    },
  };

  void registration.report().catch((error) => {
    logger?.warn?.(`[monad] NetGet registration unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  timer = setInterval(() => {
    if (stopped) return;
    void registration.report().catch(() => {});
  }, heartbeatMs);
  timer.unref?.();

  return registration;
}
