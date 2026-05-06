import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSelfSurfaceEntry,
  loadSelfNodeConfig,
  parseSelectorGroups,
  resolveSelfDispatch,
  type SelfNodeConfig,
} from "../src/http/selfMapping";

const SELF: SelfNodeConfig = {
  identity: "example.cleaker.me",
  tags: ["desktop", "local", "primary"],
  endpoint: "http://localhost:8161",
  hostname: "example-host.local",
  configPath: "/tmp/self.json",
};

describe("self mapping", () => {
  it("parses DNF selector groups with typed and bare tags", () => {
    expect(parseSelectorGroups("device:macbook,iphone|cloud;host:edge")).toEqual([
      [{ type: "device", values: ["macbook", "iphone"] }],
      [
        { type: "tag", values: ["cloud"] },
        { type: "host", values: ["edge"] },
      ],
    ]);
  });

  it("matches the local node when the selector targets one of its tags", () => {
    expect(resolveSelfDispatch("example.cleaker.me", "device:desktop", SELF)).toMatchObject({
      mode: "local",
      hasInstanceSelector: true,
      matched: ["desktop"],
      required: ["desktop"],
    });

    expect(resolveSelfDispatch("example.cleaker.me", "iphone,desktop", SELF)).toMatchObject({
      mode: "local",
      hasInstanceSelector: true,
      matched: ["desktop"],
    });
  });

  it("marks the request as remote when the identity matches but the instance does not", () => {
    expect(resolveSelfDispatch("example.cleaker.me", "device:iphone", SELF)).toMatchObject({
      mode: "remote",
      hasInstanceSelector: true,
      required: ["iphone"],
    });
  });

  it("keeps foreign namespaces outside the local identity hub", () => {
    expect(resolveSelfDispatch("bella.cleaker.me", "device:macbook", SELF)).toMatchObject({
      mode: "foreign",
      hasInstanceSelector: true,
      required: ["macbook"],
    });
  });

  it("builds a resolved surface entry from the answering host", () => {
    expect(
      buildSelfSurfaceEntry({
        self: SELF,
        origin: "http://localhost:8161",
        fallbackHost: "example-host.local",
        requestNamespace: "localhost",
        now: 1234,
      }),
    ).toMatchObject({
      hostId: "example-host.local",
      type: "desktop",
      trust: "owner",
      resources: ["public_ingress", "keychain", "filesystem", "gpu", "camera", "local_lan"],
      capacity: {
        cpuCores: null,
        ramGb: null,
        storageGb: null,
        bandwidthMbps: null,
      },
      status: {
        availability: "online",
        latencyMs: null,
        syncState: "current",
        lastSeen: 1234,
      },
      namespace: "http://example-host.local:8161",
      endpoint: "http://localhost:8161",
      rootName: "cleaker.me",
    });
  });

  it("autogenerates and persists a daemon identity when none is configured", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monad-self-"));
    const env: NodeJS.ProcessEnv = {};

    try {
      const loaded = loadSelfNodeConfig({
        cwd,
        env,
        hostname: "Suis-MacBook-Air.local",
        port: 8161,
      });

      expect(loaded).not.toBeNull();
      expect(loaded?.identity).toBe("suis-macbook-air.local");
      expect(loaded?.endpoint).toBe("http://suis-macbook-air.local:8161");
      expect(loaded?.configPath).toBe(path.join(cwd, "env/self.json"));
      expect(env.MONAD_SELF_IDENTITY).toBe(loaded?.identity);
      expect(fs.existsSync(path.join(cwd, "env/self.json"))).toBe(true);

      const persisted = JSON.parse(
        fs.readFileSync(path.join(cwd, "env/self.json"), "utf8"),
      ) as { identity?: string };
      expect(persisted.identity).toBe(loaded?.identity);

      const reloaded = loadSelfNodeConfig({
        cwd,
        env: {},
        hostname: "Suis-MacBook-Air.local",
        port: 8161,
      });
      expect(reloaded?.identity).toBe(loaded?.identity);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
