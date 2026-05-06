import express from "express";
import cors from "cors";
import { bootstrapMonad } from "./bootstrap.js";
import { createBridgeHandler } from "./handlers/bridgeHandler.js";
import { meCommandHandler, rootCommandHandler, rootCompatHandler } from "./handlers/commandHandler.js";
import { createLedgerHandlers } from "./handlers/ledgerHandler.js";
import { commitHandler, syncEventsHandler } from "./handlers/syncHandler.js";
import { createClaimsRouter } from "./http/claims.js";
import { createDisclosureMiddleware } from "./http/disclosure.js";
import { createMeshMonadsRouter } from "./http/meshMonads.js";
import { createMeshResolveRouter } from "./http/meshResolve.js";
import { createLegacyRouter } from "./http/legacy.js";
import { formatObserverRelationLabel, resolveHostNamespace, resolveTransportHost } from "./http/namespace.js";
import { normalizeHttpRequestToMeTarget } from "./http/meTarget.js";
import { createMonadsControlRouter } from "./http/monadsControl.js";
import { createSessionRouter } from "./http/session.js";
import { configureMonadShell } from "./http/shell.js";
import { recordSurfaceRequest } from "./http/surfaceTelemetry.js";
import { createFetchSurface } from "./surfaces/fetchSurface.js";
import { buildProviderBoot, createProviderSurface } from "./surfaces/providerSurface.js";
function createNoCacheStaticOptions() {
    return {
        etag: false,
        lastModified: false,
        maxAge: 0,
        setHeaders(res) {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
        },
    };
}
function requestLogger() {
    return (req, res, next) => {
        const transportHost = resolveTransportHost(req);
        const forwardedHost = resolveHostNamespace(req);
        const target = normalizeHttpRequestToMeTarget(req);
        const lens = formatObserverRelationLabel(target.relation);
        const startedAt = Date.now();
        const forwardedSuffix = forwardedHost && forwardedHost !== transportHost ? ` xf=${forwardedHost}` : "";
        console.log(`→ ${req.method} ${req.url} host=${transportHost || "unknown"} ns=${target.namespace} lens=${lens} op=${target.operation} nrp=${target.nrp}${forwardedSuffix}`);
        res.on("finish", () => {
            if (req.path === "/__surface/events")
                return;
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
export async function createMonadApp(options = {}) {
    const monad = await bootstrapMonad(options);
    const { config } = monad;
    configureMonadShell({
        cwd: config.cwd,
        guiPkgDistDir: config.guiPkgDistDir,
        indexPath: config.indexPath,
    });
    const surfaceConfig = {
        selfNodeConfig: config.selfNodeConfig,
        hostname: config.nodeHostname,
        displayName: config.nodeDisplayName,
    };
    function buildRequestProviderBoot(req, namespace) {
        return buildProviderBoot(req, namespace, surfaceConfig);
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
    const app = express();
    app.monad = monad;
    app.set("trust proxy", true);
    app.use(cors());
    app.use(express.json());
    const noCache = createNoCacheStaticOptions();
    app.use("/gui", express.static(config.guiPkgDistDir, noCache));
    app.use("/me", express.static(config.mePkgDistDir, noCache));
    app.use("/cleaker", express.static(config.cleakerPkgDistDir, noCache));
    app.use("/vendor/react", express.static(config.reactUmdDir, noCache));
    app.use("/vendor/react-dom", express.static(config.reactDomUmdDir, noCache));
    app.get("/routes.js", (_req, res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        return res.sendFile(config.routesPath);
    });
    app.use(requestLogger());
    app.use(createDisclosureMiddleware());
    app.use(createMonadsControlRouter());
    app.use(createProviderSurface(surfaceConfig));
    app.use(createFetchSurface({ timeoutMs: config.fetchProxyTimeoutMs }));
    app.get("/resolve", bridgeHandler);
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
    app.use(createMeshMonadsRouter());
    app.use(createMeshResolveRouter());
    app.use(createClaimsRouter());
    app.use(createSessionRouter());
    app.use(createLegacyRouter());
    app.get("/*", ledger.catchAll);
    return app;
}
