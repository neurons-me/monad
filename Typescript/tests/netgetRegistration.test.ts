import { describe, it, expect } from "vitest";
import ME from "this.me";
import {
  buildNetGetMonadExposure,
  buildNetGetMonadRegistrationPayload,
} from "../src/runtime/netgetRegistration.js";
import type { MonadBootstrapResult } from "../src/bootstrap.js";

function fakeBootstrap(overrides: Partial<MonadBootstrapResult["config"]> = {}): MonadBootstrapResult {
  const env = {
    MONAD_NAME: "Files Surface",
    SEED: "netget-registration-owner-seed",
  } as NodeJS.ProcessEnv;

  return {
    config: {
      cwd: "/tmp/monad-files",
      env,
      port: 8161,
      nodeHostname: "suis-macbook-air.local",
      nodeDisplayName: "suis-macbook-air.local:8161",
      fetchProxyTimeoutMs: 15000,
      mePkgDistDir: "/tmp/me",
      cleakerPkgDistDir: "/tmp/cleaker",
      guiPkgDistDir: "/tmp/gui",
      reactUmdDir: "/tmp/react",
      reactDomUmdDir: "/tmp/react-dom",
      routesPath: "/tmp/routes.js",
      indexPath: "/tmp/index.html",
      selfNodeConfig: {
        identity: "files.local",
        monadId: "monad:files",
        monadName: "files",
        tags: ["local", "monad"],
        endpoint: "http://suis-macbook-air.local:8161",
        hostname: "suis-macbook-air.local",
        configPath: "/tmp/self.json",
        resources: ["ledger"],
      },
      localNamespaceRoot: "files.local",
      ...overrides,
    },
    kernelStateDir: "/tmp/state",
    rebuiltProjectedClaims: 0,
    seededSemanticBootstrap: 0,
  };
}

function meIdentityHash(seed: string): string {
  const runtime = new (ME as any)(seed);
  return String((runtime as any)["!"].identity().hash);
}

describe("netgetRegistration", () => {
  describe("buildNetGetMonadExposure", () => {
    it("builds a loopback exposure with correct defaults", () => {
      const exposure = buildNetGetMonadExposure("Files Surface");
      expect(exposure.visibility).toBe("loopback");
      expect(exposure.publishMode).toBe("path");
      expect(exposure.inbound.paths).toEqual(["/monads/files-surface"]);
      expect(exposure.auth.requiredForControl).toBe(true);
      expect(exposure.auth.requiredForDestructive).toBe(true);
    });
  });

  describe("buildNetGetMonadRegistrationPayload", () => {
    it("builds a valid registration payload from bootstrap", () => {
      const payload = buildNetGetMonadRegistrationPayload({
        bootstrap: fakeBootstrap(),
        id: "monad:test",
        startedAt: "2026-05-26T00:00:00.000Z",
        heartbeatMs: 3_000,
      });

      expect(payload).toBeTruthy();
      expect(payload!.id).toBe("monad:test");
      expect(payload!.kind).toBe("monad");
      expect(payload!.name).toBe("monad:files-surface");
      expect(payload!.host).toBe("127.0.0.1");
      expect(payload!.port).toBe(8161);
      expect(payload!.url).toBe("http://127.0.0.1:8161");
      expect(payload!.status).toBe("running");
      expect(payload!.health.state).toBe("healthy");
      expect(payload!.lifecycle.supportsDelete).toBe(true);
      expect(payload!.exposure.visibility).toBe("loopback");
      expect(payload!.metadata.capabilities).toEqual([
        "control", "events", "gui", "ledger", "mesh", "surface",
      ]);
      expect(payload!.metadata.identity_hash).toBe(meIdentityHash("netget-registration-owner-seed"));
      expect(payload!.metadata.identityHash).toBe(payload!.metadata.identity_hash);
      expect(payload!.metadata.claimedNamespaces).toEqual(["files.local"]);
    });

    it("includes public host aliases in claimed namespaces", () => {
      const bootstrap = fakeBootstrap();
      bootstrap.config.env.MONAD_ALIASES = "netget.site, www.netget.site";
      const payload = buildNetGetMonadRegistrationPayload({
        bootstrap,
        id: "monad:test",
        startedAt: "2026-05-26T00:00:00.000Z",
        heartbeatMs: 3_000,
      });

      expect(payload!.metadata.aliases).toEqual(["netget.site", "www.netget.site"]);
      expect(payload!.metadata.claimedNamespaces).toEqual([
        "files.local",
        "netget.site",
        "www.netget.site",
      ]);
      expect(payload!.metadata.claimed_namespaces).toEqual(payload!.metadata.claimedNamespaces);
    });

    it("returns null when port is 0 (invalid bootstrap)", () => {
      const invalid = buildNetGetMonadRegistrationPayload({
        bootstrap: fakeBootstrap({ port: 0 }),
        id: "monad:invalid",
        startedAt: "2026-05-26T00:00:00.000Z",
        heartbeatMs: 3_000,
      });
      expect(invalid).toBeNull();
    });
  });
});
