import express from "express";
import cors from "cors";
import { bootstrapMonad, type MonadBootstrapResult, type MonadOptions } from "./bootstrap.js";
import { createBridgeHandler } from "./handlers/bridgeHandler.js";
import { meCommandHandler, rootCommandHandler, rootCompatHandler } from "./handlers/commandHandler.js";
import { explainRequestHandler, inspectRequestHandler } from "./handlers/explainHandler.js";
import { createLedgerHandlers } from "./handlers/ledgerHandler.js";
import { commitHandler, syncEventsHandler, namespaceOwnerHandler } from "./handlers/syncHandler.js";
import {
  getKeychainKeyHandler,
  listKeychainKeysHandler,
  recoverKeychainHandler,
  registerKeychainKeyHandler,
  revokeKeychainKeyHandler,
  signKeychainOperationHandler,
} from "./handlers/keychainHandler.js";
import {
  bootstrapGatewayAuthorityHandler,
  getGatewayAuthorityHandler,
  grantGatewayAdminHandler,
  revokeGatewayAdminHandler,
  transferGatewayOwnerHandler,
} from "./handlers/gatewayAuthorityHandler.js";
import { nodeGrantReadHandler } from "./handlers/nodeGrantsHandler.js";
import { createClaimsRouter } from "./http/claims.js";
import { createDisclosureMiddleware } from "./http/disclosure.js";
import { createMeshAnnounceRouter } from "./http/meshAnnounce.js";
import { createMeshMonadsRouter } from "./http/meshMonads.js";
import { createMeshResolveRouter } from "./http/meshResolve.js";
import { createMeshWeightsRouter } from "./http/meshWeights.js";
import { createLegacyRouter } from "./http/legacy.js";
import { formatObserverRelationLabel, resolveHostNamespace, resolveTransportHost } from "./http/namespace.js";
import { normalizeHttpRequestToMeTarget } from "./http/meTarget.js";
import { createMonadsControlRouter } from "./http/monadsControl.js";
import { createSessionRouter } from "./http/session.js";
import { configureMonadShell } from "./http/shell.js";
import { recordSurfaceRequest } from "./http/surfaceTelemetry.js";
import { createFrontendStatic } from "./http/frontend.js";
import { loadMonadModules, type MonadModulesReport } from "./modules.js";
import type { NamespaceProviderBoot } from "./http/provider.js";
import { createFetchSurface } from "./surfaces/fetchSurface.js";
import { buildProviderBoot, createProviderSurface, type ProviderSurfaceConfig } from "./surfaces/providerSurface.js";

export type MonadApp = express.Express & {
  monad: MonadBootstrapResult;
  /** What MONAD_MODULES asked for, and what came of it. */
  monadModules: MonadModulesReport;
};

function createNoCacheStaticOptions() {
  return {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders(res: express.Response) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  };
}

function requestLogger(): express.RequestHandler {
  return (req, res, next) => {
    const transportHost = resolveTransportHost(req);
    const forwardedHost = resolveHostNamespace(req);
    const target = normalizeHttpRequestToMeTarget(req);
    const lens = formatObserverRelationLabel(target.relation);
    const startedAt = Date.now();
    const forwardedSuffix = forwardedHost && forwardedHost !== transportHost ? ` xf=${forwardedHost}` : "";
    console.log(`→ ${req.method} ${req.url} host=${transportHost || "unknown"} ns=${target.namespace} lens=${lens} op=${target.operation} nrp=${target.nrp}${forwardedSuffix}`);

    res.on("finish", () => {
      if (req.path === "/__surface/events") return;
      recordSurfaceRequest({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        host: transportHost || "unknown",
        namespace: target.namespace,
        operation: target.operation,
        nrp: target.nrp,
        lens,
        forwardedHost: forwardedHost && forwardedHost !== transportHost ? forwardedHost : null,
        timestamp: startedAt,
      });
    });
    next();
  };
}

export async function createMonadApp(options: MonadOptions = {}): Promise<MonadApp> {
  const monad = await bootstrapMonad(options);
  const { config } = monad;

  configureMonadShell({
    cwd: config.cwd,
    guiPkgDistDir: config.guiPkgDistDir,
    indexPath: config.indexPath,
  });

  const surfaceConfig: ProviderSurfaceConfig = {
    selfNodeConfig: config.selfNodeConfig,
    hostname: config.nodeHostname,
    displayName: config.nodeDisplayName,
  };

  function buildRequestProviderBoot(req: express.Request, namespace: string, nodePath?: string): NamespaceProviderBoot | null {
    return buildProviderBoot(req, namespace, surfaceConfig, nodePath);
  }

  const bridgeHandler = createBridgeHandler({
    hostname: config.nodeHostname,
    port: config.port,
    selfNodeConfig: config.selfNodeConfig,
  });

  const ledger = createLedgerHandlers({
    buildRequestProviderBoot,
    onBridgeRequest: bridgeHandler,
  });

  const app = express() as MonadApp;
  app.monad = monad;
  app.monadModules = { loaded: [], failed: [] };

  app.set("trust proxy", true);
  app.use(cors());
  app.use(express.json());

  const noCache = createNoCacheStaticOptions();

  // Dev mode: proxy /gui/* to Vite dev server for HMR + ES modules.
  // Set MONAD_GUI_DEV_URL=http://localhost:5173 and run `npm run dev` in packages/GUI/npm.
  const viteDevUrl = process.env.MONAD_GUI_DEV_URL?.replace(/\/+$/, "");
  if (viteDevUrl) {
    app.use("/gui", async (req, res) => {
      const target = `${viteDevUrl}/gui${req.url}`;
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(([, v]) => v != null) as [string, string][]
          ),
        });
        res.status(upstream.status);
        upstream.headers.forEach((v, k) => res.setHeader(k, v));
        res.setHeader("Cache-Control", "no-store");
        const buf = await upstream.arrayBuffer();
        res.end(Buffer.from(buf));
      } catch {
        res.status(502).send("Vite dev server unreachable. Is it running?");
      }
    });
  } else {
    app.use("/gui", express.static(config.guiPkgDistDir, noCache));
  }
  app.use("/me", express.static(config.mePkgDistDir, noCache));
  app.use("/cleaker", express.static(config.cleakerPkgDistDir, noCache));
  app.use("/vendor/react", express.static(config.reactUmdDir, noCache));
  app.use("/vendor/react-dom", express.static(config.reactDomUmdDir, noCache));
  // A built front end, when this monad was given one: its files as they are.
  // (Its index.html is the shell's, for browser requests -- see http/shell.ts.)
  if (config.frontendDir) app.use(createFrontendStatic(config.frontendDir));
  app.get("/routes.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return res.sendFile(config.routesPath);
  });

  app.use(requestLogger());
  app.use(createDisclosureMiddleware());
  app.use(createMonadsControlRouter());
  // Packages this monad was started with (MONAD_MODULES) add their routes here,
  // ahead of the provider surface and the NRP handlers.
  app.monadModules = await loadMonadModules(app, { monad, config });
  surfaceConfig.modules = app.monadModules.loaded;
  app.use(createProviderSurface(surfaceConfig));
  app.use(createFetchSurface({ timeoutMs: config.fetchProxyTimeoutMs }));

  app.get("/resolve", bridgeHandler);
  app.post("/explain", explainRequestHandler);
  app.post("/inspect", inspectRequestHandler);
  app.post("/me/*", meCommandHandler);
  app.get("/", ledger.root);
  app.post("/", rootCompatHandler);
  app.post("/", rootCommandHandler);
  app.get("/", ledger.rootRead);
  app.get("/blocks", ledger.blocks);
  app.get("/blockchain", ledger.blockchain);
  app.get("/@*", ledger.atPath);
  app.post("/api/v1/commit", commitHandler);
  app.get("/api/v1/sync", syncEventsHandler);
  app.get("/api/v1/namespace-owner", namespaceOwnerHandler);
  app.get("/api/v1/keychain/keys", listKeychainKeysHandler);
  app.get("/api/v1/keychain/keys/:keyId", getKeychainKeyHandler);
  app.post("/api/v1/keychain/keys", registerKeychainKeyHandler);
  app.post("/api/v1/keychain/keys/:keyId/revoke", revokeKeychainKeyHandler);
  app.post("/api/v1/keychain/keys/:keyId/sign", signKeychainOperationHandler);
  app.post("/api/v1/keychain/recover", recoverKeychainHandler);
  app.get("/api/v1/gateway/:gatewayId/authority", getGatewayAuthorityHandler);
  app.post("/api/v1/gateway/:gatewayId/bootstrap", bootstrapGatewayAuthorityHandler);
  app.post("/api/v1/gateway/:gatewayId/admins", grantGatewayAdminHandler);
  app.post("/api/v1/gateway/:gatewayId/admins/:identityHash/revoke", revokeGatewayAdminHandler);
  app.post("/api/v1/gateway/:gatewayId/transfer", transferGatewayOwnerHandler);
  app.post("/api/v1/node-grants/read", nodeGrantReadHandler);
  app.use(createMeshAnnounceRouter());
  app.use(createMeshMonadsRouter());
  app.use(createMeshResolveRouter());
  app.use(createMeshWeightsRouter());
  app.use(createClaimsRouter());
  app.use(createSessionRouter());
  app.use(createLegacyRouter());
  app.get("/*", ledger.catchAll);

  return app;
}
