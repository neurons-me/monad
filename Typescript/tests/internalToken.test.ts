import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, describe, it } from "vitest";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import {
  INTERNAL_TOKEN_HEADER,
  ensureInternalToken,
  internalTokenPath,
  isGatewayRoutingRecordPath,
  isInternalRequest,
  readInternalTokenFile,
} from "../src/http/internalToken";

const ROOT = "internal-token-test.example";
const servers: Server[] = [];
const dirs: string[] = [];

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-itoken-"));
  dirs.push(root);
  delete process.env.MONAD_INTERNAL_TOKEN;
  const stateDir = path.join(root, "me-state");
  const app = await createMonadApp({
    cwd: root, seed: "internal-token-seed", namespace: ROOT,
    stateDir, claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stateDir, token: process.env.MONAD_INTERNAL_TOKEN as string };
}

async function post(origin: string, urlPath: string, body: unknown, headers: Record<string, string> = {}, host = `netget.${ROOT}`) {
  const res = await fetch(`${origin}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": host, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  resetKernelStateForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const evilRecord = { operation: "write", expression: "domains.evil__DOT__test.target", value: "http://10.0.0.1:80" };
const evilIndex = { operation: "write", expression: "domainIndex.evil__DOT__test", value: { owner: "netget" } };

describe("the gateway's routing records need an internal caller", () => {
  it("an anonymous write to an unclaimed namespace is refused for both records", async () => {
    const { origin } = await start();
    for (const body of [evilRecord, evilIndex]) {
      const out = await post(origin, "/", body);
      assert.equal(out.status, 403, JSON.stringify(body));
      assert.equal(out.json?.error, "GATEWAY_ROUTING_RECORDS_REQUIRE_INTERNAL_CALLER");
    }
  });

  it("also when written from the root under the users.<owner> prefix (the same physical place)", async () => {
    const { origin } = await start();
    const out = await post(origin, "/", { operation: "write", expression: "users.netget.domains.evil__DOT__test.target", value: "http://10.0.0.1:80" }, {}, ROOT);
    assert.equal(out.status, 403);
    const nested = await post(origin, "/", { operation: "write", expression: "users.a.users.b.domainIndex.x", value: 1 }, {}, ROOT);
    assert.equal(nested.status, 403);
  });

  it("a wrong token is as good as none; the right one writes", async () => {
    const { origin, token } = await start();
    assert.equal((await post(origin, "/", evilRecord, { [INTERNAL_TOKEN_HEADER]: "0".repeat(token.length) })).status, 403);
    assert.equal((await post(origin, "/", evilRecord, { [INTERNAL_TOKEN_HEADER]: token.slice(1) })).status, 403);
    const ok = await post(origin, "/", evilRecord, { [INTERNAL_TOKEN_HEADER]: token });
    assert.equal(ok.status, 200);
  });

  it("the commit surface refuses it too, and other paths in the same namespace stay open as before", async () => {
    const { origin } = await start();
    const commit = await post(origin, "/api/v1/commit", {
      namespace: `netget.${ROOT}`, events: [{ namespace: `netget.${ROOT}`, path: "domains.evil__DOT__test.target", data: "x" }],
    });
    assert.equal(commit.status, 403);
    assert.equal(commit.json?.error, "GATEWAY_ROUTING_RECORDS_REQUIRE_INTERNAL_CALLER");
    const other = await post(origin, "/", { operation: "write", expression: "profile.bio", value: "hello" });
    assert.equal(other.status, 200);
  });
});

describe("the token itself", () => {
  it("is stored 0600 next to the state dir, and a restart keeps it", async () => {
    const { stateDir, token } = await start();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(readInternalTokenFile(stateDir), token);
    const file = internalTokenPath(stateDir);
    assert.equal(path.dirname(file), path.dirname(path.resolve(stateDir)));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    delete process.env.MONAD_INTERNAL_TOKEN;
    assert.equal(ensureInternalToken(stateDir), token);
  });

  it("an environment token wins and is what the process uses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-itoken-env-"));
    dirs.push(root);
    const env = { MONAD_INTERNAL_TOKEN: "operator-provided" } as NodeJS.ProcessEnv;
    assert.equal(ensureInternalToken(path.join(root, "me-state"), env), "operator-provided");
    assert.equal(isInternalRequest({ headers: { [INTERNAL_TOKEN_HEADER]: "operator-provided" } }, env), true);
    assert.equal(isInternalRequest({ headers: {} }, env), false);
    assert.equal(isInternalRequest({ headers: { [INTERNAL_TOKEN_HEADER]: "operator-provided" } }, {} as NodeJS.ProcessEnv), false);
  });

  it("reserves the branch under any users.<label> prefix and nothing that merely resembles it", () => {
    for (const p of ["domains", "domains.a", "domains/a/target", "domainIndex", "domainIndex.a", "users.x.domains.a", "users.x.users.y.domainIndex.a"]) {
      assert.equal(isGatewayRoutingRecordPath(p), true, p);
    }
    for (const p of ["domainsX.a", "profile.domains", "users.x.profile", "netget.main.server.name", ""]) {
      assert.equal(isGatewayRoutingRecordPath(p), false, p);
    }
  });
});
