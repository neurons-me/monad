import type { Server } from "node:http";
import { createMonadApp, type MonadApp } from "./app.js";
import {
  bootstrapMonad,
  type MonadBootstrapResult,
  type MonadLogger,
  type MonadOptions,
  type MonadRuntimeConfig,
} from "./bootstrap.js";
import type {
  SelfNodeConfig,
  SelfSurfaceCapacity,
  SelfSurfaceTrust,
  SelfSurfaceType,
} from "./http/selfMapping.js";
import { getKernelStateDir } from "./kernel/manager.js";
import { setupPersistence } from "./kernel/persist.js";
import { readMonadIndexEntry, touchSelfMonadLastSeen } from "./kernel/monadIndex.js";
import { announceToSurface } from "./http/meshAnnounce.js";

/**
 * Options for starting a complete monad.ai HTTP daemon.
 */
export interface StartMonadOptions extends MonadOptions {
  /** Disable periodic snapshot persistence when set to `false`. */
  setupPersistence?: boolean;
}

/**
 * Handles returned by {@link startMonad}.
 */
export interface StartMonadResult {
  app: MonadApp;
  server: Server;
  bootstrap: MonadBootstrapResult;
}

function resolveLogger(logger: MonadLogger | false | undefined): MonadLogger | null {
  if (logger === false) return null;
  return logger || console;
}

function printStartupBanner(bootstrap: MonadBootstrapResult, logger: MonadLogger): void {
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
  logger.log("\n🌐 Mesh Surface");
  logger.log("  - Announce in:    POST /.mesh/announce  (other monads register here)");
  logger.log("  - Announce out:   MONAD_SURFACE_URL=" + (process.env.MONAD_SURFACE_URL || "(not set — local only)"));
  logger.log("\n🔎 Namespace Reads");
  logger.log("  - Resolve path:   GET  /<any/path>   e.g. /profile/displayName");
  logger.log("");
}

/**
 * Boots the monad runtime, creates the Express app, starts listening, and
 * schedules the local monad heartbeat.
 */
export async function startMonad(options: StartMonadOptions = {}): Promise<StartMonadResult> {
  const app = await createMonadApp(options);
  const { config } = app.monad;

  if (options.setupPersistence !== false) {
    setupPersistence();
  }

  const logger = resolveLogger(options.logger);
  const server = app.listen(config.port, () => {
    if (logger) printStartupBanner(app.monad, logger);
  });

  const selfMonadId = config.selfNodeConfig?.monadId || process.env.MONAD_ID || "";
  if (selfMonadId) {
    const heartbeat = setInterval(() => touchSelfMonadLastSeen(selfMonadId), 30_000);
    heartbeat.unref();
  }

  // Outgoing surface announce — registers this monad in a remote mesh surface.
  // MONAD_SURFACE_URL=https://cleaker.me  (or sui-macbook.local, neurons.me, etc.)
  // MONAD_ANNOUNCE_INTERVAL_MS (default 30000)
  const surfaceUrl = process.env.MONAD_SURFACE_URL || "";
  if (selfMonadId && surfaceUrl) {
    const intervalMs = Math.max(10_000, parseInt(process.env.MONAD_ANNOUNCE_INTERVAL_MS || "30000", 10));

    // Announce on startup (after server is listening), then on interval.
    server.once("listening", () => {
      const entry = readMonadIndexEntry(selfMonadId);
      if (entry) {
        announceToSurface(surfaceUrl, entry);
        const announceInterval = setInterval(() => {
          const current = readMonadIndexEntry(selfMonadId);
          if (current) announceToSurface(surfaceUrl, current);
        }, intervalMs);
        announceInterval.unref();
      }
    });
  }

  return {
    app,
    server,
    bootstrap: app.monad,
  };
}

export { createMonadApp, bootstrapMonad };
export {
  announceClaimedNamespaces,
  findMonadByName,
  findMonadByNameAsync,
  findMonadsForNamespace,
  findMonadsForNamespaceAsync,
  listMonadIndex,
  listMonadIndexAsync,
  readMonadIndexEntry,
  seedSelfMonadIndexEntry,
  touchSelfMonadLastSeen,
  writeMonadIndexEntry,
  type MonadIndexEntry,
} from "./kernel/monadIndex.js";
export {
  DEFAULT_STALE_MS,
  matchesMeshSelector,
  selectMeshClaimant,
  type MeshRunnerUp,
  type MeshSelection,
} from "./kernel/meshSelect.js";
export {
  DEFAULT_WEIGHTS,
  GLOBAL_BACKGROUND_SHARE,
  LEARNING_RATE,
  NAMESPACE_MATURITY_SAMPLES,
  WEIGHT_MIN,
  getWeightReport,
  readAdaptiveWeights,
  resolveAdaptiveWeights,
  updateAdaptiveWeights,
  type AdaptiveWeightUpdateOptions,
  type WeightHealth,
  type WeightReport,
} from "./kernel/adaptiveWeights.js";
export {
  computeScore,
  computeScoreDetailed,
  readClaimMeta,
  recordForwardResult,
  writeClaimMeta,
  type ClaimMeta,
  type ScoreBreakdown,
  type Scorer,
  type ScorerBreakdown,
  type ScoringContext,
  type ScoringMode,
} from "./kernel/scoring.js";
export {
  correlateOutcome,
  recordDecision,
  type DecisionEntry,
} from "./kernel/decisionLog.js";
export {
  NRP_TEST_CATALOG,
  type NrpTestCatalogEntry,
} from "./testing/nrpTestCatalog.js";
export type {
  MonadApp,
  MonadBootstrapResult,
  MonadLogger,
  MonadOptions,
  MonadRuntimeConfig,
  SelfNodeConfig,
  SelfSurfaceCapacity,
  SelfSurfaceTrust,
  SelfSurfaceType,
};
