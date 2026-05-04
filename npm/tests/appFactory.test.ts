import fs from "fs";
import os from "os";
import path from "path";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";

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

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-app-factory-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    routesPath: path.join(root, "routes.js"),
    indexPath: path.join(root, "index.html"),
  };
}

describe("createMonadApp", () => {
  let envSnapshot: EnvSnapshot;
  let runtimeRoot: string | null = null;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    resetKernelStateForTests();
  });

  afterEach(() => {
    resetKernelStateForTests();
    restoreEnv(envSnapshot);
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = null;
    }
  });

  it("creates an Express app without binding a port", async () => {
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
      logger: false,
    });

    expect(typeof app.listen).toBe("function");
    const routes = ((app as any)._router?.stack || [])
      .map((layer: any) => layer.route?.path)
      .filter(Boolean);
    expect(routes).toContain("/blocks");
    expect(routes).toContain("/api/v1/commit");
  });

  it("validates SEED when the factory bootstraps, not at import time", async () => {
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
