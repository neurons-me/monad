import { Router, type Router as ExpressRouter } from "express";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";
import { resolveNamespace, resolveTransportHost } from "../http/namespace.js";
import { resolveNamespacePathValue } from "../http/pathResolver.js";
import {
  buildNamespaceProviderBoot,
  resolveNamespaceSurfaceSpec,
} from "../http/provider.js";
import {
  buildSelfSurfaceEntry,
  type SelfNodeConfig,
} from "../http/selfMapping.js";
import {
  attachSurfaceStreamClient,
  getSurfaceTelemetrySnapshot,
} from "../http/surfaceTelemetry.js";
import { resolveRequestOrigin, resolveRequestSurfaceRoute } from "../runtime/requestContext.js";

export type ProviderSurfaceConfig = {
  selfNodeConfig: SelfNodeConfig | null;
  hostname: string;
  displayName: string;
};

function buildSurfaceEntry(
  req: Parameters<typeof resolveRequestOrigin>[0],
  namespace: string,
  config: ProviderSurfaceConfig,
) {
  const origin = resolveRequestOrigin(req, config.hostname);
  return buildSelfSurfaceEntry({
    self: config.selfNodeConfig,
    origin,
    fallbackHost: config.hostname,
    requestNamespace: namespace,
  });
}

export function buildProviderBoot(
  req: Parameters<typeof resolveRequestOrigin>[0],
  namespace: string,
  config: ProviderSurfaceConfig,
) {
  return buildNamespaceProviderBoot({
    namespace,
    route: resolveRequestSurfaceRoute(req),
    origin: resolveRequestOrigin(req, config.hostname),
    resolverHostName: config.hostname,
    resolverDisplayName: config.displayName,
    surfaceEntry: buildSurfaceEntry(req, namespace, config),
  });
}

export function createProviderSurface(config: ProviderSurfaceConfig): ExpressRouter {
  const router = Router();

  router.get("/__bootstrap", (req, res) => {
    const namespace = resolveNamespace(req);
    const host = resolveTransportHost(req);
    const origin = resolveRequestOrigin(req, host);
    const target = normalizeHttpRequestToMeTarget(req);
    const surfaceEntry = buildSurfaceEntry(req, namespace, config);
    const provider = buildProviderBoot(req, namespace, config);
    const telemetry = getSurfaceTelemetrySnapshot();
    return res.json(createEnvelope(target, {
      host,
      namespace,
      apiOrigin: origin,
      resolverHostName: config.hostname,
      resolverDisplayName: config.displayName,
      provider,
      surfaceEntry: { ...surfaceEntry, ...telemetry },
    }));
  });

  router.get("/__provider", (req, res) => {
    const namespace = String((req.query as any)?.namespace || "").trim() || resolveNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const provider = buildProviderBoot(req, namespace, config);
    return res.json(createEnvelope(target, { namespace, provider }));
  });

  router.get("/__provider/resolve", async (req, res) => {
    const namespace = String((req.query as any)?.namespace || "").trim() || resolveNamespace(req);
    const rawPath = String((req.query as any)?.path || "").trim();
    const route = resolveRequestSurfaceRoute(req);
    const target = normalizeHttpRequestToMeTarget(req);

    if (!rawPath) {
      return res.status(400).json(createErrorEnvelope(target, {
        namespace, path: "", route,
        error: "PATH_REQUIRED",
        detail: "NamespaceProvider.resolve requires ?path=",
      }));
    }

    const resolved = await resolveNamespacePathValue(namespace, rawPath);
    if (!resolved.found) {
      return res.status(404).json(createErrorEnvelope(target, {
        namespace, path: resolved.path || rawPath, route, error: "PATH_NOT_FOUND",
      }));
    }

    return res.json(createEnvelope(target, {
      namespace: resolved.namespace,
      path: resolved.path,
      route,
      value: resolved.value,
    }));
  });

  router.get("/__provider/surface", (req, res) => {
    const namespace = String((req.query as any)?.namespace || "").trim() || resolveNamespace(req);
    const route = resolveRequestSurfaceRoute(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const surfaceEntry = buildSurfaceEntry(req, namespace, config);
    const surface = resolveNamespaceSurfaceSpec({ namespace, route, surfaceEntry });
    return res.json(createEnvelope(target, { namespace, path: route, route, surface, surfaceEntry }));
  });

  router.get("/__surface", (req, res) => {
    const namespace = resolveNamespace(req);
    const host = resolveTransportHost(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const surfaceEntry = buildSurfaceEntry(req, namespace, config);
    return res.json(createEnvelope(target, {
      host,
      namespace,
      surfaceEntry: { ...surfaceEntry, ...getSurfaceTelemetrySnapshot() },
    }));
  });

  router.get("/__surface/events", (req, res) => {
    attachSurfaceStreamClient(req, res);
  });

  return router;
}
