import { createMonadApp } from "./app.js";
import { bootstrapMonad } from "./bootstrap.js";
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
        logger.log(`∷ Seeded ${seededSemanticBootstrap} root semantic memories in ${config.localNamespaceRoot}`);
    }
    logger.log(`\n🚀 Monad.ai daemon running at: http://localhost:${config.port}`);
    logger.log("\n∴ Material Surface");
    logger.log(`  - State Dir:      ${getKernelStateDir()}`);
    logger.log("  - Give thought:   POST /        (append JSON into current namespace)");
    logger.log("  - Reach thought:  GET  /        (read current namespace surface)");
    logger.log("  - Read blocks:    GET  /blocks  (explicit block stream view)");
    logger.log("  - Provider boot:  GET  /__provider");
    logger.log("  - Provider read:  GET  /__provider/resolve?path=profile/name");
    logger.log("  - Provider GUI:   GET  /__provider/surface?route=/");
    logger.log("\n🔐 Claim Surface");
    logger.log("  - Claim space:    POST /claims       (forge claim record + encrypted noise)");
    logger.log("  - Open space:     POST /claims/open  (verify trinity -> recover noise)");
    logger.log("  - Kernel claim:   POST /me/kernel:claim/<full-namespace>");
    logger.log("  - Kernel open:    POST /me/kernel:open/<full-namespace>");
    logger.log("\n🌐 Routing / Namespaces");
    logger.log("  - Host header determines the chain namespace");
    logger.log("  - Examples:");
    logger.log("    • cleaker.me                  -> cleaker.me");
    logger.log("    • username.cleaker.me         -> username.cleaker.me");
    logger.log(`    • localhost (loopback alias)  -> ${config.localNamespaceRoot}`);
    logger.log(`    • username.localhost          -> username.${config.localNamespaceRoot} (loopback alias projection)`);
    logger.log("    • cleaker.me/@username        -> username.cleaker.me (path projection)");
    logger.log(`    • localhost/@username         -> username.${config.localNamespaceRoot} (loopback alias projection)`);
    if (config.selfNodeConfig) {
        logger.log("\n🪞 Self Mapping");
        logger.log(`  - Identity:       ${config.selfNodeConfig.identity}`);
        logger.log(`  - Tags:           ${config.selfNodeConfig.tags.join(", ") || "(none)"}`);
        logger.log(`  - Endpoint:       ${config.selfNodeConfig.endpoint}`);
        logger.log(`  - Config Path:    ${config.selfNodeConfig.configPath}`);
    }
    logger.log("\n🔎 Namespace Reads");
    logger.log("  - Resolve path:   GET  /<any/path>   e.g. /profile/displayName");
    logger.log("\n🕰 Legacy Extensions");
    logger.log("  - Claim username: POST /users");
    logger.log("  - Lookup user:    GET  /users/:username\n");
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
