// sessionHostFlowDisabled.test.ts
//
// Live proof, against a real in-process monad (app.listen(0), real HTTP,
// no mocks), that the four mutating session/host routes found issuing
// credentials and authorization records from caller-supplied data with no
// identity check (2026-10-04 audit) are now disabled -- anonymous
// requests, and requests for an arbitrary "victim" identity, produce no
// token and no record, from any of the four routes, with a real Host
// header resolving to this monad's own configured root (not the
// "unknown"/foreign-namespace path, which would reject for an unrelated
// reason and prove nothing about THIS fix). The two surviving GET reads
// are confirmed to still work.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import crypto from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";

const ROOT_NAMESPACE = `session-disabled-test.local`;

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-session-disabled-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

// Node's fetch (undici) treats Host as a forbidden header name and
// silently drops an explicit override -- using http.request directly so
// the Host header genuinely resolves to this monad's own configured root,
// not the anonymous/"unknown" namespace (which has its own, unrelated
// foreign-namespace rejection that would give a false pass here).
function request(port: number, method: string, urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: {
          host: ROOT_NAMESPACE,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode || 0, json: json ?? text });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("session/host flow -- disabled after 2026-10-04 audit finding", () => {
  let server: Server;
  let port: number;
  let runtimeRoot: string;
  let runtimeDir: string;

  beforeAll(async () => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-session-disabled-cwd-"));
    const runtime = createTempRuntime();
    runtimeDir = runtime.root;
    const app = await createMonadApp({
      cwd: runtimeRoot,
      seed: "test-seed-session-disabled",
      namespace: ROOT_NAMESPACE,
      stateDir: runtime.stateDir,
      claimDir: runtime.claimDir,
      selfConfigPath: runtime.selfConfigPath,
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("the Host header actually resolves to this monad's real root, not the anonymous/\"unknown\" path", async () => {
    const r = await request(port, "GET", "/api/v1/hosts/resolution-check", undefined);
    expect(r.json?.target?.namespace?.me).toBe(ROOT_NAMESPACE);
  });

  it("POST /api/v1/session/cloud no longer issues a token for an arbitrary username with zero credentials", async () => {
    const r = await request(port, "POST", "/api/v1/session/cloud", {
      username: "victim-account",
      capabilities: ["admin:everything", "sync", "sign", "local_fs"],
    });
    expect(r.status).toBe(410);
    expect(r.json?.error).toBe("SESSION_HOST_FLOW_DISABLED");
    expect(r.json?.token).toBeUndefined();
  });

  it("POST /api/v1/session/nonce no longer hands out a nonce for an arbitrary username with zero credentials", async () => {
    const r = await request(port, "POST", "/api/v1/session/nonce", { username: "victim-account" });
    expect(r.status).toBe(410);
    expect(r.json?.error).toBe("SESSION_HOST_FLOW_DISABLED");
    expect(r.json?.nonce).toBeUndefined();
  });

  it("POST /api/v1/session/host-verify no longer accepts a self-signed attestation (attacker's own key signs its own challenge)", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fingerprint = "attacker-fabricated-fingerprint";
    const message = `victim-account:fake-nonce:${fingerprint}`;
    const signer = crypto.createSign("SHA256");
    signer.update(message);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64");
    const daemonPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const r = await request(port, "POST", "/api/v1/session/host-verify", {
      username: "victim-account",
      nonce: "fake-nonce",
      host: {
        fingerprint,
        daemonPublicKey: daemonPublicKeyPem,
        attestation: signature,
        label: "attacker-fabricated-host",
        hostname: "attacker.example",
        local_endpoint: "http://attacker.example:9999",
      },
    });
    expect(r.status).toBe(410);
    expect(r.json?.error).toBe("SESSION_HOST_FLOW_DISABLED");
    expect(r.json?.session).toBeUndefined();
  });

  it("no fabricated host record landed for victim-account -- the real regression this fix is for", async () => {
    const r = await request(port, "GET", "/api/v1/hosts/victim-account", undefined);
    expect(r.status).toBe(200);
    expect(r.json?.hosts).toEqual([]);
  });

  it("POST /api/v1/hosts/revoke no longer revokes an arbitrary {username, hostFingerprint} with zero credentials", async () => {
    const r = await request(port, "POST", "/api/v1/hosts/revoke", { username: "victim-account", hostFingerprint: "anything" });
    expect(r.status).toBe(410);
    expect(r.json?.error).toBe("SESSION_HOST_FLOW_DISABLED");
    expect(r.json?.revoked).toBeUndefined();
  });

  it("the two surviving GET reads still work -- never the exploitable part, and listing an always-empty-going-forward result is harmless", async () => {
    const r1 = await request(port, "GET", "/api/v1/hosts/anyone", undefined);
    expect(r1.status).toBe(200);
    expect(Array.isArray(r1.json?.hosts)).toBe(true);

    const r2 = await request(port, "GET", "/api/v1/hosts/anyone/some-fingerprint/history", undefined);
    expect(r2.status).toBe(200);
    expect(Array.isArray(r2.json?.memories)).toBe(true);
  });
});
