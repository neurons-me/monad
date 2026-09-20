import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, describe, it } from "vitest";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { listSemanticMemoriesByNamespace } from "../src/claim/memoryStore";
import {
  MAIN_SERVER_NAME_PATH,
  isMainServerReservedPath,
  normalizeMainServerName,
} from "../src/claim/mainServer";

const ROOT = "main-server-test.example";
const servers: Server[] = [];

async function start(mainServerName?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-main-server-"));
  const app = await createMonadApp({
    cwd: root,
    seed: "main-server-test-seed",
    namespace: ROOT,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    ...(mainServerName ? { mainServerName } : {}),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function read(origin: string, host: string, dotPath: string) {
  const res = await fetch(`${origin}/${dotPath}`, {
    headers: { "x-forwarded-host": host, accept: "application/json" },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, value: json?.target?.value, disclosure: json?.disclosure };
}

async function post(origin: string, urlPath: string, body: unknown) {
  const res = await fetch(`${origin}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": ROOT },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  resetKernelStateForTests();
  // createMonadApp writes its resolved config into process.env; do not let one case's value seed the next.
  delete process.env.MONAD_MAIN_SERVER_NAME;
});

describe("main server name is a path of the namespace", () => {
  it("reads as netget.main.server.name, publicly", async () => {
    const origin = await start("netget.site");
    const got = await read(origin, ROOT, MAIN_SERVER_NAME_PATH);
    assert.equal(got.status, 200);
    assert.equal(got.value, "netget.site");
    assert.equal(got.disclosure, "public");
  });

  it("is declared only when the operator asked for it", async () => {
    const origin = await start();
    const got = await read(origin, ROOT, MAIN_SERVER_NAME_PATH);
    assert.equal(got.status, 404);
  });

  it("normalizes what the operator typed and refuses what is not a host", () => {
    assert.equal(normalizeMainServerName(" https://Netget.Site/ "), "netget.site");
    assert.equal(normalizeMainServerName("not a host"), null);
    assert.equal(normalizeMainServerName(""), null);
  });

  it("refuses an unsigned write from POST / -- nobody names the admin domain over HTTP", async () => {
    const origin = await start("netget.site");
    const out = await post(origin, "/", { operation: "write", expression: MAIN_SERVER_NAME_PATH, value: "evil.example" });
    assert.equal(out.status, 403);
    assert.equal(out.json?.error, "GATEWAY_PATH_REQUIRES_GATEWAY_API");
    assert.equal((await read(origin, ROOT, MAIN_SERVER_NAME_PATH)).value, "netget.site");
  });

  it("refuses overwriting the branch through its parent", async () => {
    const origin = await start("netget.site");
    for (const expression of ["netget.main", "netget"]) {
      const out = await post(origin, "/", { operation: "write", expression, value: { server: { name: "evil.example" } } });
      assert.equal(out.status, 403, expression);
    }
    assert.equal((await read(origin, ROOT, MAIN_SERVER_NAME_PATH)).value, "netget.site");
  });

  it("refuses it through the commit surface too", async () => {
    const origin = await start("netget.site");
    const out = await post(origin, "/api/v1/commit", {
      namespace: ROOT,
      events: [{ namespace: ROOT, path: MAIN_SERVER_NAME_PATH, data: "evil.example" }],
    });
    assert.equal(out.status, 403);
    assert.equal(out.json?.error, "GATEWAY_PATH_REQUIRES_GATEWAY_API");
  });

  it("does not grow the log when started again with the same value", async () => {
    await start("netget.site");
    const count = () => listSemanticMemoriesByNamespace(ROOT, { limit: 10000 }).filter((m) => m.path === MAIN_SERVER_NAME_PATH).length;
    assert.equal(count(), 1);
    await start("netget.site");
    assert.equal(count(), 1);
  });

  it("reserves the branch and nothing next to it", () => {
    assert.equal(isMainServerReservedPath("netget.main.server.name"), true);
    assert.equal(isMainServerReservedPath("netget/main/server/name"), true);
    assert.equal(isMainServerReservedPath("netget.main"), true);
    assert.equal(isMainServerReservedPath("netget"), true);
    assert.equal(isMainServerReservedPath("netget.mainstream"), false);
    assert.equal(isMainServerReservedPath("users.jabellae.netget.main"), false);
  });
});
