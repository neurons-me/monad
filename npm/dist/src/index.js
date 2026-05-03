import { createMonadApp } from "./app.js";
import { bootstrapMonad, } from "./bootstrap.js";
import { getKernelStateDir } from "./kernel/manager.js";
import { setupPersistence } from "./kernel/persist.js";
function resolveLogger(logger) {
    if (logger === false)
        return null;
    return logger || console;
}
function printStartupBanner(bootstrap, logger) {
    const { config, rebuiltProjectedClaims, seededSemanticBootstrap } = bootstrap;
    if (rebuiltProjectedClaims > 0) {
        logger.log(`↺ Rebuilt ${rebuiltProjectedClaims} projected user pointers into root namespaces`);
    }
    if (seededSemanticBootstrap > 0) {
        logger.log(`∷ Prepared ${seededSemanticBootstrap} system bootstrap memories in ${config.localNamespaceRoot}`);
    }
    const self = config.selfNodeConfig;
    const endpoint = self?.endpoint || `http://localhost:${config.port}`;
    const identity = self?.identity || config.localNamespaceRoot;
    logger.log(`\n🚀 Monad.ai surface running at: ${endpoint}`);
    logger.log("\n∴ Rootspace / Common Ground");
    logger.log(`  - Current surface: ${identity}`);
    logger.log(`  - Local rootspace: ${config.localNamespaceRoot}`);
    logger.log("  - Host header selects the namespace being served.");
    logger.log("  - Rootspace authority can read/write the place itself.");
    logger.log("  - Personal authority mounts into the place by claim proof.");
    logger.log("\n∴ Semantic Surface");
    logger.log(`  - State Dir:       ${getKernelStateDir()}`);
    logger.log("  - Read namespace:  GET  /<path>");
    logger.log("  - Write namespace: POST /");
    logger.log("  - Blocks:          GET  /blocks");
    logger.log("  - Provider boot:   GET  /__provider");
    logger.log("  - Provider read:   GET  /__provider/resolve?path=profile/name");
    logger.log("  - Surface status:  GET  /__surface");
    logger.log("\n🔐 Authority / Claims");
    logger.log("  - Claim namespace: POST /claims");
    logger.log("  - Sign in:         POST /claims/signIn");
    logger.log("  - Kernel claim:    POST /me/kernel:claim/<full-namespace>");
    logger.log("\n🌐 Namespace Addressing");
    logger.log("  - cleaker.me                  -> rootspace common ground");
    logger.log("  - username.cleaker.me         -> personal namespace mounted in rootspace");
    logger.log(`  - localhost                   -> ${config.localNamespaceRoot}`);
    logger.log(`  - username.localhost          -> username.${config.localNamespaceRoot}`);
    logger.log("  - cleaker.me/@username        -> username.cleaker.me");
    logger.log(`  - localhost/@username         -> username.${config.localNamespaceRoot}`);
    if (config.selfNodeConfig) {
        logger.log("\n🪞 Self Mapping");
        logger.log(`  - Identity:       ${config.selfNodeConfig.identity}`);
        logger.log(`  - Tags:           ${config.selfNodeConfig.tags.join(", ") || "(none)"}`);
        logger.log(`  - Endpoint:       ${config.selfNodeConfig.endpoint}`);
        logger.log(`  - Config Path:    ${config.selfNodeConfig.configPath}`);
    }
    logger.log("\n🔎 Namespace Reads");
    logger.log("  - Resolve path:   GET  /<any/path>   e.g. /profile/displayName");
    logger.log("");
}
export async function startMonad(options = {}) {
    const app = await createMonadApp(options);
    const { config } = app.monad;
    if (options.setupPersistence !== false) {
        setupPersistence();
    }
    const logger = resolveLogger(options.logger);
    const server = app.listen(config.port, () => {
        if (logger)
            printStartupBanner(app.monad, logger);
    });
    return {
        app,
        server,
        bootstrap: app.monad,
    };
}
export { createMonadApp, bootstrapMonad };
