/**
 * gatewayRecordReadExposure.test.ts — the gateway's domain records do not leave the monad to an anonymous reader.
 *
 * netget keeps its domain records in the monad: users.<owner>.domains.<key>.* and users.netget.domainIndex.<key>
 * (netget kernel/domainStore.ts). netget's own policy for them (GET /domains, routes/localNetget.js): anyone gets the
 * projection domain/type/subdomain/tlsConfigured; the full configuration only an admin with gateway:read. The writes
 * were already reserved to the monad's internal caller (internalToken.ts); this covers the reads.
 *
 * The check does not look for field names: each stored value is a unique marker, and the test asserts that no marker
 * appears ANYWHERE in the bytes of any anonymous answer (any route, any representation: memory rows, ledger blocks,
 * branch trees, directory rows, inspection, NRP frames). The internal caller still reads the full record.
 */
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMonadApp } from "../../src/index";
import { attachNrpWebSocketServer } from "../../src/http/nrpHandler";
import { getKernelMemoryLog, resetKernelStateForTests } from "../../src/kernel/manager";
import ME from "this.me";
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from "../../src/http/internalToken";
import {
  isGatewayRecordPath,
  mayReachGatewayRecords,
  pruneGatewayRecords,
  withoutGatewayRecordIndex,
  withoutGatewayRecordRows,
} from "../../src/http/gatewayRecordDisclosure";

const ROOT = "gw-read-test.example";
const KEY = "probe__DOT__example";
const MARK = {
  target: "http://10.77.0.1:47771",
  sslCertificate: "/srv/zz9-marker/cert-fullchain.pem",
  sslCertificateKey: "/srv/zz9-marker/cert-privkey.pem",
  email: "zz9-marker-contact@example.invalid",
  owner: "zz9markerowner",
  projectPath: "/srv/zz9-marker/project",
  nginxConfig: "zz9-marker-nginx-block",
  dnsProvider: "zz9-marker-dns",
  identity: "zz9-marker-identity-hash",
  connections: "[{\"prefix\":\"/zz9-marker-api\",\"target\":\"http://10.77.0.2:47772\"}]",
};
const INDEX_MARK = "zz9-marker-index-owner";
const markers = [...Object.values(MARK), INDEX_MARK, "10.77.0.1", "10.77.0.2", "zz9-marker", "zz9marker"];

let server: Server;
let origin: string;
let wsUrl: string;
let token: string;
let dir: string;

async function call(method: string, urlPath: string, opts: { host?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.host) headers["x-forwarded-host"] = opts.host;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${origin}${urlPath}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, text: await res.text() };
}

async function writeInternal(host: string, expression: string, value: unknown) {
  const out = await call("POST", "/", { host, body: { operation: "write", expression, value }, headers: { [INTERNAL_TOKEN_HEADER]: token } });
  assert.equal(out.status, 200, `${expression}: ${out.text}`);
}

function nrpSend(message: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("nrp timeout")); }, 3000);
    ws.on("open", () => ws.send(JSON.stringify(message)));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (["resolved", "error", "data"].includes(msg.type)) { clearTimeout(timer); ws.close(); resolve(String(data)); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
const nrp = (expression: string) => nrpSend({ type: "nrp.open", expression, canonical: expression, ast: null });

const CAROL = { username: "carolgw" };
let carolNode: any;
let openNonce = 0;
async function carolOpen(route: "/claims/signIn" | "/claims/open" | "/me/kernel:open", headers: Record<string, string> = {}) {
  openNonce += 1;
  const ns = `${CAROL.username}.${ROOT}`;
  const proof = await carolNode.prove({ rootNamespace: ROOT, challenge: `open:gw-read-${openNonce}-${Date.now()}` });
  return call("POST", route, { body: { namespace: ns, proof }, headers });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gw-read-"));
  delete process.env.MONAD_INTERNAL_TOKEN;
  const app = await createMonadApp({
    cwd: dir, seed: "gw-read-seed", namespace: ROOT,
    stateDir: path.join(dir, "me-state"), claimDir: path.join(dir, "claims"), selfConfigPath: path.join(dir, "self.json"),
  });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  attachNrpWebSocketServer(server);
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/nrp`;
  token = process.env.MONAD_INTERNAL_TOKEN as string;
  // What netget writes (domainStore.ts): one field per write, under the owner's namespace, and the index under netget's.
  for (const owner of ["netget", "alice"]) {
    for (const [field, value] of Object.entries(MARK)) await writeInternal(`${owner}.${ROOT}`, `domains.${KEY}.${field}`, value);
    await writeInternal(`${owner}.${ROOT}`, `domains.${KEY}.type`, "proxy");
  }
  await writeInternal(`netget.${ROOT}`, `domainIndex.${KEY}`, { owner: INDEX_MARK });
  // From the root too, under the users.<owner> prefix (the same physical place).
  // (a write from the root into users.bob.* is refused as another namespace's storage; bob writes as itself)
  await writeInternal(`bob.${ROOT}`, `domains.${KEY}.target`, MARK.target);
  // A CLAIMED namespace holding a record: its owner's sign-in returns its memories. (Written before the claim: after it,
  // even the internal caller needs the owner's signature to write there.)
  for (const [field, value] of Object.entries(MARK)) await writeInternal(`${CAROL.username}.${ROOT}`, `domains.${KEY}.${field}`, value);
  // A test identity from a random seed (its own .me key signs the claim and the opens).
  const me = new (ME as any)(Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""));
  me["@"](CAROL.username);
  carolNode = me["!"];
  const claimProof = await carolNode.prove({ rootNamespace: ROOT, challenge: JSON.stringify({ method: "POST", nonce: "gw-claim-1", path: "/claims", timestamp: Date.now() }) });
  const claimed = await call("POST", "/claims", { body: { namespace: `${CAROL.username}.${ROOT}`, proof: claimProof, username: CAROL.username, name: "Carol Test", email: "carol@example.invalid", phone: "5550000000" } });
  assert.equal(claimed.status, 201, claimed.text);
  // An ordinary public value next to them, to show the reads themselves still work.
  const pub = await call("POST", "/", { host: `netget.${ROOT}`, body: { operation: "write", expression: "profile.bio", value: "public-bio-visible" } });
  assert.equal(pub.status, 200, pub.text);
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  resetKernelStateForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  fs.rmSync(dir, { recursive: true, force: true });
});

const hosts = [undefined, ROOT, `netget.${ROOT}`, `alice.${ROOT}`, `bob.${ROOT}`, "localhost", "unknown"];
const getPaths = [
  "/", "/?limit=5000", "/blocks", "/blocks?limit=5000", "/blockchain", "/blockchain?includeSystem=1&limit=5000",
  "/@netget", "/@alice", "/@bob", "/@netget/domains", "/@alice/domains", `/@netget/domains/${KEY}`, "/@netget/domainIndex",
  "/domains", `/domains/${KEY}`, `/domains/${KEY}/target`, "/domainIndex", `/domainIndex/${KEY}`,
  "/users", "/users/netget", "/users/alice", "/users/bob", "/users/netget/domains", "/users/alice/domains",
  `/users/alice/domains/${KEY}`, "/users/netget/domainIndex", "/users/bob/domains",
  "/users/netget/users/alice/domains",
  `/__provider/resolve?path=domains`, `/__provider/resolve?path=users`, `/__provider/resolve?path=users.alice`,
  `/__provider/resolve?path=users.netget.domainIndex`, `/__provider/resolve?namespace=${ROOT}&path=users`,
  `/__provider/resolve?namespace=netget.${ROOT}&path=domains`, `/__provider/resolve?namespace=${ROOT}&path=users.alice.domains`,
  `/api/v1/sync?namespace=netget.${ROOT}`, `/api/v1/sync?namespace=alice.${ROOT}`, `/api/v1/sync?namespace=${ROOT}`,
  `/api/v1/sync?namespace=bob.${ROOT}`,
  `/__provider/resolve?path=domains["${KEY}"].target`, `/__provider/resolve?path=domains[${KEY}]`, `/__provider/resolve?path=domains/${KEY}`,
  `/__provider/resolve?path=users["alice"].domains`, `/__provider/resolve?path=users`,
  `/domains%2F${KEY}%2Ftarget`, `/domains/${KEY}/`, `/@netget/@netget/domains`, `/@alice/domains/${KEY}/target`,
  `/users/carolgw`, `/users/carolgw/domains`, `/@carolgw`, `/@carolgw/domains`,
  `/resolve?target=${encodeURIComponent(`me://netget.${ROOT}/domains`)}`, `/resolve?target=${encodeURIComponent(`me://${ROOT}/users/alice`)}`,
  `/domains%2E${KEY}%2Etarget`, `//domains//${KEY}//target`, `/domains/${KEY}/./target`, `/domains;x/${KEY}`,
  `/@netget.${ROOT}/domains`, `/@netget/@alice/domains`, `/@alice/@netget/domainIndex`,
  `/__provider/resolve?path=.domains`, `/__provider/resolve?path=domains.`, `/__provider/resolve?path=/domains/${KEY}/`,
  `/__provider/resolve?path=%20domains`, `/__provider/resolve?path=domains['${KEY}']`, `/__provider/resolve?path=users["netget"]["domainIndex"]`,
  `/__provider/resolve?path=domains..${KEY}`, `/__provider/resolve?path=domainIndex.${KEY}.owner`,
  "/users/alice/x", "/api/v1/hosts/netget", "/api/v1/hosts/alice/x/history", "/__bootstrap", "/__provider", "/__surface", "/__provider/surface",
];

describe("anonymous reads never carry a gateway record value", () => {
  it("every GET route, from every host", async () => {
    const leaks: string[] = [];
    for (const host of hosts) {
      for (const p of getPaths) {
        const out = await call("GET", p, { host });
        const hit = markers.find((m) => out.text.includes(m));
        if (hit) leaks.push(`${host ?? "(address)"} GET ${p} -> ${out.status} contains ${hit}`);
      }
    }
    assert.deepEqual(leaks, []);
   }, 30_000); // ~420 requests: well under a second each, but the full suite runs files in parallel

  it("POST /inspect and /explain", async () => {
    const leaks: string[] = [];
    for (const host of hosts) {
      for (const [p, body] of [
        ["/inspect", {}], ["/inspect", { last: 100000 }],
        ["/explain", { path: "domains" }], ["/explain", { path: `domains.${KEY}.target` }],
        ["/explain", { path: "users.alice.domains" }], ["/explain", { path: "domainIndex" }], ["/explain", { path: "users" }],
        ["/explain", { path: `domains["${KEY}"].target` }], ["/explain", { path: `domains[${KEY}].target` }],
        ["/explain", { path: "domains[*].target" }], ["/explain", { path: "*.target" }], ["/explain", { path: `*.${KEY}.target` }],
        ["/explain", { path: "users[*].domains[*].target" }], ["/explain", { path: `users.alice.domains.${KEY}.target` }],
        ["/explain", { path: "sum(domains[*].target)" }], ["/explain", { path: "count(users.alice.domains)" }],
        ["/explain", { path: `users.netget.domainIndex.${KEY}` }], ["/explain", { path: `domains/${KEY}/target` }],
        ["/explain", { path: " domains" }], ["/explain", { path: "domains." }], ["/explain", { path: ".domains" }],
        ["/explain", { path: `domains..${KEY}.target` }], ["/explain", { path: `domains['${KEY}'].target` }],
        ["/explain", { path: `users["netget"]["domains"]["${KEY}"].target` }], ["/explain", { path: "users[netget].domainIndex" }],
        ["/explain", { path: `users.*.domains.${KEY}.target` }], ["/explain", { path: "max(users[*].domains[*].target)" }],
      ] as Array<[string, unknown]>) {
        const out = await call("POST", p, { host, body });
        const hit = markers.find((m) => out.text.includes(m));
        if (hit) leaks.push(`${host ?? "(address)"} POST ${p} ${JSON.stringify(body)} -> ${out.status} contains ${hit}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  it("NRP reads", async () => {
    const leaks: string[] = [];
    for (const expr of [
      `me://netget.${ROOT}/domains`, `me://alice.${ROOT}/domains`, `me://netget.${ROOT}/domainIndex`,
      `me://${ROOT}/users`, `me://${ROOT}/users/alice/domains`, `me://${ROOT}/users/alice`, `me://alice.${ROOT}`,
      `me://netget.${ROOT}/domains/${KEY}/target`, `me://netget.${ROOT}:read/domains`, `me://netget.${ROOT}/domains["${KEY}"]`,
      `me://${ROOT}/users/netget/domainIndex`, `me://alice.${ROOT}/domains/${KEY}`,
    ]) {
      const text = await nrp(expr);
      const hit = markers.find((m) => text.includes(m));
      if (hit) leaks.push(`${expr} contains ${hit}`);
    }
    for (const type of ["read", "subscribe"]) {
      for (const [namespace, p] of [
        [`netget.${ROOT}`, "domains"], [`netget.${ROOT}`, `domains.${KEY}.target`], [`netget.${ROOT}`, "domainIndex"],
        [`alice.${ROOT}`, "domains"], [ROOT, "users"], [ROOT, "users.alice"], [ROOT, "users.alice.domains"],
        [ROOT, `users.netget.domainIndex.${KEY}`], [`netget.${ROOT}`, `domains/${KEY}/target`],
      ]) {
        const text = await nrpSend({ type, channelId: "c1", namespace, path: p });
        const hit = markers.find((m) => text.includes(m));
        if (hit) leaks.push(`nrp ${type} ${namespace} ${p} contains ${hit}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  it("the owner's sign-in returns the namespace's memories without them", async () => {
    const leaks: string[] = [];
    for (const route of ["/claims/signIn", "/claims/open", "/me/kernel:open"] as const) {
      const out = await carolOpen(route);
      assert.equal(out.status, 200, `${route}: ${out.text}`);
      assert.ok(out.text.includes("memories"), route);
      const hit = markers.find((m) => out.text.includes(m));
      if (hit) leaks.push(`${route} contains ${hit}`);
    }
    assert.deepEqual(leaks, []);
  });
});

describe("what still works", () => {
  it("an anonymous read still shows ordinary public values, in every representation", async () => {
    for (const p of ["/blocks", "/blockchain", `/api/v1/sync?namespace=netget.${ROOT}`, "/profile/bio", "/profile"]) {
      const out = await call("GET", p, { host: `netget.${ROOT}` });
      assert.ok(out.text.includes("public-bio-visible"), `${p}: ${out.status} ${out.text.slice(0, 300)}`);
    }
    const insp = await call("POST", "/inspect", { host: ROOT, body: {} });
    assert.ok(insp.text.includes("public-bio-visible"));
  });

  it("a record path is answered closed whether a record exists there or not (no existence oracle)", async () => {
    const present = await call("GET", `/domains/${KEY}/target`, { host: `netget.${ROOT}` });
    const absent = await call("GET", "/domains/nothing__DOT__here/target", { host: `netget.${ROOT}` });
    assert.equal(present.status, 200);
    assert.equal(absent.status, 200);
    assert.equal(JSON.parse(present.text).disclosure ?? JSON.parse(present.text).target?.disclosure, "closed");
    assert.equal(
      JSON.stringify({ ...JSON.parse(present.text), target: undefined }).replace(KEY, "X"),
      JSON.stringify({ ...JSON.parse(absent.text), target: undefined }).replace("nothing__DOT__here", "X"),
    );
  });

  it("the internal caller (netget) still reads the full record, by path and in the ledger", async () => {
    const internal = { [INTERNAL_TOKEN_HEADER]: token };
    const rec = await call("GET", `/domains/${KEY}`, { host: `netget.${ROOT}`, headers: internal });
    assert.equal(rec.status, 200, rec.text);
    for (const v of Object.values(MARK)) assert.ok(rec.text.includes(JSON.stringify(v).slice(1, -1)) || rec.text.includes(v), v);
    const idx = await call("GET", "/domainIndex", { host: `netget.${ROOT}`, headers: internal });
    assert.ok(idx.text.includes(INDEX_MARK));
    const blocks = await call("GET", "/blocks", { host: `netget.${ROOT}`, headers: internal });
    assert.ok(blocks.text.includes(MARK.target));
    const open = await carolOpen("/claims/signIn", internal);
    assert.ok(open.text.includes(MARK.target));
  });

  it("the bypass fails closed: anything but the exact token leaves the filter on", async () => {
    const variants: Array<[string, Record<string, string> | Headers]> = [
      ["no header", {}],
      ["empty", { [INTERNAL_TOKEN_HEADER]: "" }],
      ["spaces", { [INTERNAL_TOKEN_HEADER]: "   " }],
      ["same length, wrong", { [INTERNAL_TOKEN_HEADER]: "0".repeat(token.length) }],
      ["prefix", { [INTERNAL_TOKEN_HEADER]: token.slice(0, -1) }],
      ["token + extra", { [INTERNAL_TOKEN_HEADER]: `${token}0` }],
      ["upper case", { [INTERNAL_TOKEN_HEADER]: token.toUpperCase() }],
      ["padded", { [INTERNAL_TOKEN_HEADER]: ` ${token}x` }],
      ["as authorization", { authorization: `Bearer ${token}` }],
      ["other header name", { "x-monad-internal": token }],
    ];
    const dup = new Headers(); dup.append(INTERNAL_TOKEN_HEADER, token); dup.append(INTERNAL_TOKEN_HEADER, token);
    variants.push(["duplicated header", dup]);
    const leaks: string[] = [];
    for (const [name, headers] of variants) {
      for (const p of [`/domains/${KEY}`, "/blocks", "/blockchain", `/api/v1/sync?namespace=netget.${ROOT}`]) {
        const res = await fetch(`${origin}${p}${p.includes("?") ? "&" : "?"}token=${token}`, { headers: { accept: "application/json", "x-forwarded-host": `netget.${ROOT}`, ...Object.fromEntries(new Headers(headers as any)) } });
        const text = await res.text();
        if (markers.some((m) => text.includes(m))) leaks.push(`${name} ${p}`);
      }
      const insp = await call("POST", "/inspect", { host: ROOT, body: {}, headers: Object.fromEntries(new Headers(headers as any)) });
      if (markers.some((m) => insp.text.includes(m))) leaks.push(`${name} /inspect`);
    }
    assert.deepEqual(leaks, []);
    // A monad whose configured token is empty never treats a request as internal, whatever it sends.
    for (const given of ["", " ", "x"]) {
      assert.equal(isInternalRequest({ headers: { [INTERNAL_TOKEN_HEADER]: given } }, { MONAD_INTERNAL_TOKEN: "" } as NodeJS.ProcessEnv), false);
      assert.equal(isInternalRequest({ headers: { [INTERNAL_TOKEN_HEADER]: given } }, {} as NodeJS.ProcessEnv), false);
    }
  });

  it("the stored chain is unchanged: every record is still there, and the reads above wrote nothing", async () => {
    const log = getKernelMemoryLog();
    for (const v of Object.values(MARK)) assert.ok(log.some((m: any) => m.value === v), v);
    assert.ok(log.some((m: any) => m.value?.owner === INDEX_MARK));
    // Every request appends the monad's own usage telemetry (surface.*), unrelated to this change: not counted.
    const own = () => getKernelMemoryLog().filter((m: any) => !String(m.path).startsWith("surface.")).length;
    const before = own();
    await call("GET", "/blocks", { host: ROOT });
    await call("GET", `/domains/${KEY}`, { host: `netget.${ROOT}` });
    await call("POST", "/inspect", { host: ROOT, body: {} });
    assert.equal(own(), before);
  });
});

describe("the filter itself (parent values, spellings)", () => {
  it("recognizes a record path in every spelling, and nothing that merely resembles one", () => {
    for (const p of ["domains", `domains.${KEY}.target`, `domains/${KEY}/target`, `domains["${KEY}"].target`, `domains[${KEY}]`,
      "domainIndex", `users.alice.domains.${KEY}`, `users["alice"].domains`, "users.a.users.b.domainIndex.x"]) {
      assert.equal(isGatewayRecordPath(p), true, p);
    }
    for (const p of ["profile.domains", "domainsX", "users.alice.profile", "netget.main.server.name", ""]) {
      assert.equal(isGatewayRecordPath(p), false, p);
    }
  });

  it("an expression that could reach one: parents, wildcards, aggregates", () => {
    for (const p of ["users", "users.alice", "users.*", "*", "*.target", "domains[*].target", "users[*].domains[*].port",
      "sum(users.netget.domains[*].port)", "count(users.alice.domains)", "users.*.domainIndex"]) {
      assert.equal(mayReachGatewayRecords(p), true, p);
    }
    for (const p of ["profile.bio", "users.alice.profile.bio", "users.*.profile", "sum(users.alice.scores[*])"]) {
      assert.equal(mayReachGatewayRecords(p), false, p);
    }
  });

  it("prunes record subtrees from a parent's value without touching the original", () => {
    const tree = { alice: { profile: { bio: "x" }, domains: { k: { target: MARK.target } } }, netget: { domainIndex: { k: { owner: "o" } }, profile: { domains: "mine" } } };
    const snapshot = JSON.stringify(tree);
    const pruned = pruneGatewayRecords("users", tree) as any;
    assert.equal(JSON.stringify(tree), snapshot);
    assert.deepEqual(pruned, { alice: { profile: { bio: "x" } }, netget: { profile: { domains: "mine" } } });
    assert.equal(pruneGatewayRecords("users.alice.domains", { k: 1 }), undefined);
    assert.equal(pruneGatewayRecords("profile", tree.alice.profile), tree.alice.profile); // same reference when nothing goes
    const rows = withoutGatewayRecordRows([
      { path: "users", value: tree }, { path: `users.alice.domains.${KEY}.target`, value: MARK.target }, { path: "profile.bio", data: "ok" },
    ]);
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes(MARK.target));
    assert.ok(!JSON.stringify(withoutGatewayRecordIndex({ users: tree, [`users.alice.domains.${KEY}.target`]: MARK.target })).includes(MARK.target));
  });
});
