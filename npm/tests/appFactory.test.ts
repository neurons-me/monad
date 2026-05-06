/**
 * appFactory.test.ts — The Application Factory
 *
 * WHAT IS createMonadApp?
 * `createMonadApp` is the entry point that wires together all the monad.ai subsystems
 * into a working Express application:
 *
 *   HTTP server → routes → kernel → claim system → mesh routing → scoring
 *
 * It takes a configuration object with all the paths, identity settings, and options
 * that the app needs. It returns a configured Express app BEFORE binding to a port.
 * The server owner then calls app.listen(port) when ready.
 *
 * WHY TEST THE FACTORY?
 * The factory is responsible for:
 *   1. Validating configuration (e.g., SEED must be set)
 *   2. Registering all the expected routes (/blocks, /api/v1/commit, etc.)
 *   3. NOT binding a port (so tests don't need open sockets)
 *
 * WHAT WE TEST:
 *   1. Happy path: factory produces a real Express app with expected routes
 *   2. Validation: missing SEED causes a clear rejection at factory time, not at import time
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";

// ── Environment isolation ─────────────────────────────────────────────────────
// Save a snapshot of all relevant env vars before each test.
// After each test, restore the snapshot to undo any env changes the test made.
// Without this, test B might run with SEED deleted by test A.

const ENV_KEYS = [
  "SEED",
  "ME_SEED",
  "ME_NAMESPACE",
  "ME_STATE_DIR",
  "MONAD_CLAIM_DIR",
  "MONAD_SELF_CONFIG_PATH",
  "MONAD_SELF_IDENTITY",
  "MONAD_SELF_HOSTNAME",
  "MONAD_SELF_ENDPOINT",
  "MONAD_SELF_TAGS",
  "MONAD_FETCH_TIMEOUT_MS",
  "GUI_PKG_DIST_DIR",
  "ME_PKG_DIST_DIR",
  "CLEAKER_PKG_DIST_DIR",
  "LOCAL_REACT_UMD_DIR",
  "LOCAL_REACTDOM_UMD_DIR",
  "MONAD_ROUTES_PATH",
  "MONAD_INDEX_PATH",
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return ENV_KEYS.reduce((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {} as EnvSnapshot);
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Creates a temporary directory structure that mimics a real monad runtime.
// The factory needs these paths to exist for config file loading and serving assets.
function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-app-factory-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),      // kernel state storage
    claimDir: path.join(root, "claims"),          // namespace claim records
    selfConfigPath: path.join(root, "self.json"), // this node's identity config
    routesPath: path.join(root, "routes.js"),     // optional custom routes
    indexPath: path.join(root, "index.html"),     // frontend entrypoint
  };
}

describe("createMonadApp", () => {
  let envSnapshot: EnvSnapshot;
  let runtimeRoot: string | null = null;

  beforeEach(() => {
    envSnapshot = snapshotEnv(); // save current env before test
    resetKernelStateForTests();  // ensure kernel starts clean
  });

  afterEach(() => {
    resetKernelStateForTests();
    restoreEnv(envSnapshot);    // undo any env changes
    if (runtimeRoot) {
      // Clean up temp directory to avoid disk accumulation across test runs
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = null;
    }
  });

  it("creates an Express app without binding a port", async () => {
    // WHAT: Call createMonadApp with a full valid configuration.
    //       Verify the returned object is a real Express app.
    //
    // HOW: We check:
    //   1. typeof app.listen === "function" — it's an Express app (not undefined or a plain object)
    //   2. The registered routes include /blocks (blockchain endpoint)
    //      and /api/v1/commit (memory commit endpoint)
    //
    // WHY: This is the smoke test for the entire factory. If this fails, no routes are
    //      registered and every HTTP request would return 404. Since we don't call
    //      app.listen(), no port is opened — tests don't need network access.
    //
    // port: 0 is conventional for "don't actually bind" — but we don't call listen() anyway.
    const runtime = createTempRuntime();
    runtimeRoot = runtime.root;

    const app = await createMonadApp({
      cwd: runtime.root,
      seed: "test-seed-monad-app-factory",
      namespace: "cleaker.me",
      stateDir: runtime.stateDir,
      claimDir: runtime.claimDir,
      selfConfigPath: runtime.selfConfigPath,
      selfIdentity: "cleaker.me",
      selfHostname: "localhost",
      selfEndpoint: "http://localhost:0",
      selfTags: ["localhost", "local"],
      port: 0,
      guiPkgDistDir: runtime.root,
      mePkgDistDir: runtime.root,
      cleakerPkgDistDir: runtime.root,
      reactUmdDir: runtime.root,
      reactDomUmdDir: runtime.root,
      routesPath: runtime.routesPath,
      indexPath: runtime.indexPath,
      logger: false, // suppress request logging during tests
    });

    // It must be an Express app (has a .listen method)
    expect(typeof app.listen).toBe("function");

    // Extract registered route paths from the Express router stack
    const routes = ((app as any)._router?.stack || [])
      .map((layer: any) => layer.route?.path)
      .filter(Boolean);

    expect(routes).toContain("/blocks");           // blockchain/history endpoint
    expect(routes).toContain("/api/v1/commit");    // memory write endpoint
  });

  it("validates SEED when the factory bootstraps, not at import time", async () => {
    // WHAT: Delete SEED and ME_SEED from the environment, then call createMonadApp.
    //       The factory should reject with an error containing "SEED is required".
    //
    // WHY: SEED is required for cryptographic identity generation. Without it, the
    //      daemon can't derive a consistent identity hash and all cryptographic
    //      operations would be non-deterministic.
    //
    //      The validation happens at FACTORY TIME (when createMonadApp is called),
    //      NOT at module import time. This means:
    //        - You can import { createMonadApp } at the top of your server file
    //          even before the env is configured
    //        - The error only fires when you actually try to start the app
    //
    //      Without this guarantee, `import { createMonadApp }` would crash in
    //      environments where env vars are loaded after the import (e.g., dotenv).
    const runtime = createTempRuntime();
    runtimeRoot = runtime.root;
    delete process.env.SEED;
    delete process.env.ME_SEED;

    await expect(createMonadApp({
      cwd: runtime.root,
      namespace: "cleaker.me",
      stateDir: runtime.stateDir,
      claimDir: runtime.claimDir,
      selfConfigPath: runtime.selfConfigPath,
      selfIdentity: "cleaker.me",
      selfHostname: "localhost",
      selfEndpoint: "http://localhost:0",
      port: 0,
      logger: false,
    })).rejects.toThrow(/SEED is required/);
  });
});
