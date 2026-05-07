/**
 * Demos/socialGraph.test.ts — Social Graph Over a Real Namespace
 *
 * THE this.me DEMO RUNS IN MEMORY.
 * THIS TEST RUNS OVER HTTP.
 *
 * The this.me social graph example uses an in-process kernel:
 *   me.profile.name("J. Abella")           // writes directly to memory
 *   me("profile.name")                     // reads directly from memory
 *
 * Here, every operation goes through a REAL Express server:
 *   POST / {path: "profile.name", value: "J. Abella"}   Host: jabellae.demo.local
 *   GET  /profile/name                                   Host: jabellae.demo.local
 *
 * The monad resolves the Host header into a namespace, routes the request,
 * stores or retrieves the data, and wraps the result in an NRP envelope.
 *
 * ─── THE NAMESPACE HIERARCHY ────────────────────────────────────────────────
 *
 *  Root:   demo.local                     (.local = real local deployment pattern)
 *  User:   jabellae.demo.local            (jabellae's personal namespace)
 *
 *  The monad control guard restricts process management to local hosts only
 *  (localhost, 127.x.x.x, *.local). That's why real deployments use .local
 *  suffixes — "suis-macbook-air.local", "jabellae.demo.local", etc.
 *  cleaker.me is the public domain used once data is published to the mesh.
 *
 *  NOTE: We use "contacts.*" (not "users.*") for the social graph paths.
 *  The monad legacy router intercepts GET /users/:username for the blockchain
 *  user registry — a different system. "contacts.*" is a clean semantic path.
 *
 *  Inside jabellae.demo.local:
 *    profile.name            = "J. Abella"
 *    profile.age             = 28
 *    profile.city            = "Veracruz"
 *    contacts.ana.name       = "Ana"
 *    contacts.ana.age        = 22
 *    contacts.ana.city       = "CDMX"
 *    contacts.pablo.name     = "Pablo"
 *    contacts.pablo.age      = 17
 *    contacts.pablo.city     = "Monterrey"
 *    contacts.luisa.name     = "Luisa"
 *    contacts.luisa.age      = 31
 *    contacts.luisa.city     = "Xalapa"
 *    friends.ana  →  contacts.ana          (pointer: friend link)
 *    friends.pablo→  contacts.pablo
 *    friends.luisa→  contacts.luisa
 *
 *  And in ana.demo.local (her own namespace, separate):
 *    profile.name            = "Ana Gonzalez"
 *    profile.city            = "CDMX"
 *
 * ─── WHAT EACH REQUEST PROVES ───────────────────────────────────────────────
 *
 *  POST /  → writes a semantic memory to the namespace (via NRP write op)
 *  GET  /profile/name      → leaf read  → returns a single string value
 *  GET  /profile           → branch read → returns {name, age, city} as object
 *  GET  /contacts/ana      → branch read → returns {name, age, city} for Ana
 *  GET  /friends/luisa     → pointer read → returns the __ptr marker
 *
 * ─── THE NRP ANNOTATION ─────────────────────────────────────────────────────
 *
 * Every response envelope includes:
 *   target.nrp   = "me://jabellae.demo.local:read/profile.name"
 *   target.path  = "profile.name"       (dot notation, no leading slash)
 *   target.namespace.me = "jabellae.demo.local"
 *
 * This is the Namespace Resolution Protocol in action: every HTTP call is
 * expressed as a me:// address so the mesh can route, proxy, or cache it.
 *
 * ─── WHAT WE TEST ───────────────────────────────────────────────────────────
 *   1. Write profile fields via POST → read back via GET (leaf)
 *   2. Write multiple fields → read back as a branch object (GET /profile)
 *   3. Write a social graph (contacts.ana, contacts.pablo, contacts.luisa)
 *   4. Branch read: GET /contacts/ana returns {name, age, city} as one object
 *   5. Write friend pointers (-> operator) → pointer value is preserved
 *   6. Two different namespaces (jabellae vs ana) are completely isolated
 *   7. Every response carries a correct NRP nrp= field
 */

import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createMonadApp } from "../../src/index";
import { resetKernelStateForTests } from "../../src/kernel/manager";

// ── Shared app and namespace ──────────────────────────────────────────────────

// The root namespace for this demo. jabellae is a user projected under it.
// .local suffix is required — the monad control guard only allows local hosts
// (localhost, 127.x.x.x, *.local). This matches the real deployment pattern:
// your machine is "suis-macbook-air.local", your namespace is "you.suis-macbook-air.local".
const ROOT_NS = "demo.local";
const JABELLAE_NS = "jabellae.demo.local";
const ANA_NS = "ana.demo.local";

// Minimal temp runtime — same pattern as appFactory.test.ts
function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-social-demo-"));
  return {
    root,
    stateDir: path.join(root, "state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    routesPath: path.join(root, "routes.js"),
    indexPath: path.join(root, "index.html"),
  };
}

describe("Social Graph — real namespace over HTTP", () => {
  let app: Awaited<ReturnType<typeof createMonadApp>>;
  let runtimeRoot: string;

  // ── Spin up the monad app once for the entire describe block ───────────────
  beforeAll(async () => {
    // WHAT: Create a fresh monad server with root namespace = "demo.local".
    //       This means:
    //         jabellae.demo.local → kernel prefix "users.jabellae" (internal)
    //         ana.demo.local      → kernel prefix "users.ana"      (internal)
    //       Any Host header matching *.demo.local resolves to that user's namespace.
    //       The kernel prefix is an internal detail — the HTTP paths we write and
    //       read are the semantic paths (profile.name, contacts.ana.city, etc.).
    resetKernelStateForTests();
    const runtime = tempRuntime();
    runtimeRoot = runtime.root;

    app = await createMonadApp({
      cwd: runtime.root,
      seed: "demo-social-graph-seed",
      namespace: ROOT_NS,
      stateDir: runtime.stateDir,
      claimDir: runtime.claimDir,
      selfConfigPath: runtime.selfConfigPath,
      selfIdentity: ROOT_NS,
      selfHostname: "demo.local",
      selfEndpoint: "http://localhost:0",
      selfTags: ["demo", "local"],
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
  });

  afterAll(() => {
    resetKernelStateForTests();
    if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  // ── Helper: POST a semantic memory to a namespace ──────────────────────────
  // WHAT: Sends POST / with the given path+value, scoped to the namespace via Host header.
  //       This is exactly what a real monad client would do: write a datum to a namespace.
  async function write(namespace: string, pathStr: string, value: unknown, operator?: string) {
    const body: Record<string, unknown> = { path: pathStr, value };
    if (operator) body.operator = operator;
    const res = await request(app)
      .post("/")
      .set("Host", namespace)
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res.body;
  }

  // ── Helper: GET a path from a namespace and return the full response ────────
  // WHAT: Sends GET /<path> with the Host header = namespace.
  //       The monad resolves the namespace from Host, looks up the path,
  //       and returns it wrapped in an NRP envelope.
  async function read(namespace: string, pathStr: string) {
    const urlPath = "/" + pathStr.replace(/\./g, "/");
    const res = await request(app)
      .get(urlPath)
      .set("Host", namespace);
    return res;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. WRITE + READ: jabellae's profile fields
  // ─────────────────────────────────────────────────────────────────────────────

  it("writes profile fields to jabellae.demo.local and reads them back as leaves", async () => {
    // WHAT: Write three scalar values under the "profile" path in jabellae's namespace.
    //       Then read each one back individually.
    //
    // HOW: POST / with Host: jabellae.demo.local routes to the jabellae namespace.
    //      The monad stores each field as a semantic memory:
    //        namespace = jabellae.demo.local
    //        path      = profile.name
    //        data      = "J. Abella"
    //
    //      GET /profile/name with Host: jabellae.demo.local reads it back.
    //      The path "/profile/name" is converted to dotPath "profile.name" by the resolver.
    //      The response envelope includes the NRP address: me://jabellae.demo.local:read/profile.name
    //
    // WHY: This is the most fundamental NRP operation — writing and reading a scalar
    //      value at a named path in a specific namespace. If this fails, nothing else works.

    await write(JABELLAE_NS, "profile.name", "J. Abella");
    await write(JABELLAE_NS, "profile.age", 28);
    await write(JABELLAE_NS, "profile.city", "Veracruz");

    const nameRes = await read(JABELLAE_NS, "profile.name");
    expect(nameRes.status).toBe(200);
    expect(nameRes.body.target.value).toBe("J. Abella");
    // The NRP address is constructed from the namespace + path
    expect(nameRes.body.target.nrp).toMatch(/jabellae\.demo\.local/);

    const ageRes = await read(JABELLAE_NS, "profile.age");
    expect(ageRes.status).toBe(200);
    expect(ageRes.body.target.value).toBe(28);

    const cityRes = await read(JABELLAE_NS, "profile.city");
    expect(cityRes.status).toBe(200);
    expect(cityRes.body.target.value).toBe("Veracruz");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. BRANCH READ: the whole profile as a single object
  // ─────────────────────────────────────────────────────────────────────────────

  it("reads the entire profile branch as a nested object with one GET", async () => {
    // WHAT: GET /profile (no sub-path) with Host: jabellae.demo.local.
    //       Instead of a single scalar, the resolver returns ALL paths under
    //       "profile.*" assembled into a nested object.
    //
    // HOW: readSemanticBranchForNamespace("jabellae.demo.local", "profile") scans
    //      all memories where namespace = jabellae.demo.local AND path starts with "profile.".
    //      It assembles them into: { name: "J. Abella", age: 28, city: "Veracruz" }
    //
    // WHY: This is the semantic branch read — a single HTTP call that retrieves
    //      a whole sub-graph. The UI page renderer uses this to get all profile
    //      data in one request instead of 3 individual ones.

    const res = await read(JABELLAE_NS, "profile");
    expect(res.status).toBe(200);
    expect(res.body.target.value).toMatchObject({
      name: "J. Abella",
      age: 28,
      city: "Veracruz",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. WRITE: the social graph (jabellae's contacts)
  // ─────────────────────────────────────────────────────────────────────────────

  it("writes the social graph — three contacts with name, age, city", async () => {
    // WHAT: Write ana, pablo, and luisa's data into jabellae's namespace under "contacts.*".
    //       Also write friend pointer links under "friends.*".
    //
    // HOW: All writes use Host: jabellae.demo.local, so they all land in jabellae's
    //      namespace. The paths "contacts.ana.name", "contacts.pablo.age", etc. form a
    //      sub-graph under jabellae's namespace — his personal knowledge of these people.
    //
    //      Friend links use operator "->" (pointer). The value "contacts.ana" is a
    //      reference — it tells consumers to look up jabellae's contacts.ana data.
    //
    // WHY: A social graph is a namespace pattern: each node (person) has their own
    //      sub-path. The "friends.*" pointers are how the graph edges are expressed.
    //      The mesh can follow these pointers across namespaces for cross-user resolution.

    // Ana: 22, from CDMX
    await write(JABELLAE_NS, "contacts.ana.name", "Ana");
    await write(JABELLAE_NS, "contacts.ana.age", 22);
    await write(JABELLAE_NS, "contacts.ana.city", "CDMX");

    // Pablo: 17, from Monterrey
    await write(JABELLAE_NS, "contacts.pablo.name", "Pablo");
    await write(JABELLAE_NS, "contacts.pablo.age", 17);
    await write(JABELLAE_NS, "contacts.pablo.city", "Monterrey");

    // Luisa: 31, from Xalapa
    await write(JABELLAE_NS, "contacts.luisa.name", "Luisa");
    await write(JABELLAE_NS, "contacts.luisa.age", 31);
    await write(JABELLAE_NS, "contacts.luisa.city", "Xalapa");

    // Friend pointer links: friends.X -> contacts.X
    // operator "->" stores a __ptr marker so consumers know it's a reference
    await write(JABELLAE_NS, "friends.ana", "contacts.ana", "->");
    await write(JABELLAE_NS, "friends.pablo", "contacts.pablo", "->");
    await write(JABELLAE_NS, "friends.luisa", "contacts.luisa", "->");

    // Verify one leaf to confirm all writes landed
    const res = await read(JABELLAE_NS, "contacts.luisa.city");
    expect(res.status).toBe(200);
    expect(res.body.target.value).toBe("Xalapa");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. BRANCH READ: a full contact node as an object
  // ─────────────────────────────────────────────────────────────────────────────

  it("reads contacts.ana as a complete branch object — name + age + city in one GET", async () => {
    // WHAT: GET /contacts/ana with Host: jabellae.demo.local.
    //       Returns ALL fields under "contacts.ana.*" as a nested object.
    //
    // HOW: The path resolver converts "/contacts/ana" → dotPath "contacts.ana".
    //      readSemanticBranchForNamespace finds:
    //        contacts.ana.name = "Ana"
    //        contacts.ana.age  = 22
    //        contacts.ana.city = "CDMX"
    //      And assembles: { name: "Ana", age: 22, city: "CDMX" }
    //
    // WHY: The branch read pattern means any UI component can fetch a whole person
    //      node with a single HTTP call. This scales to arbitrarily deep sub-graphs.

    const res = await read(JABELLAE_NS, "contacts.ana");
    expect(res.status).toBe(200);
    expect(res.body.target.value).toMatchObject({
      name: "Ana",
      age: 22,
      city: "CDMX",
    });
  });

  it("reads contacts.pablo as a complete branch object", async () => {
    const res = await read(JABELLAE_NS, "contacts.pablo");
    expect(res.status).toBe(200);
    expect(res.body.target.value).toMatchObject({
      name: "Pablo",
      age: 17,
      city: "Monterrey",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. POINTER READ: friends.luisa returns a __ptr reference marker
  // ─────────────────────────────────────────────────────────────────────────────

  it("reads a friend pointer — friends.luisa returns the __ptr reference marker", async () => {
    // WHAT: GET /friends/luisa returns the stored pointer value, not the resolved target.
    //
    // HOW: The friend link was written with operator "->", which stores it as:
    //        { __ptr: "contacts.luisa" }
    //      The HTTP path resolver reads the semantic store and returns this marker.
    //      Pointer FOLLOWING (jumping to contacts.luisa) is a separate operation —
    //      the bridge handler handles that via the ?target= query or NRP forwarding.
    //
    // WHY: Separating storage from resolution is intentional. The namespace stores
    //      the graph STRUCTURE (this friend link points to contacts.luisa). The mesh
    //      layer decides whether to follow, proxy, or cache the target. This lets
    //      the same pointer work locally or across machines.

    const res = await read(JABELLAE_NS, "friends.luisa");
    expect(res.status).toBe(200);
    // The __ptr marker tells consumers: "follow this reference to contacts.luisa"
    expect(res.body.target.value).toMatchObject({ __ptr: "contacts.luisa" });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. NAMESPACE ISOLATION: jabellae's data is not visible from ana's namespace
  // ─────────────────────────────────────────────────────────────────────────────

  it("jabellae's graph data is not visible from ana.demo.local — namespaces are isolated", async () => {
    // WHAT: Write a field to ana.demo.local (a completely different namespace).
    //       Then verify that jabellae's data is NOT visible from ana's namespace,
    //       and vice versa.
    //
    // HOW: The namespace is derived from the Host header. Two different Host values
    //      produce two different namespaces which map to different kernel prefixes:
    //        jabellae.demo.local → internal kernel prefix "users.jabellae"
    //        ana.demo.local      → internal kernel prefix "users.ana"
    //      These are disjoint subtrees — they cannot see each other's data.
    //
    // WHY: Namespace isolation is a security guarantee. If jabellae can read ana's
    //      private data just by changing the path, the whole identity model breaks.
    //      This test proves the Host header is the namespace boundary.

    // Ana writes her OWN profile.name in HER OWN namespace
    await write(ANA_NS, "profile.name", "Ana Gonzalez");
    await write(ANA_NS, "profile.city", "CDMX");

    // Ana's own namespace returns her data
    const anaOwnProfile = await read(ANA_NS, "profile.name");
    expect(anaOwnProfile.status).toBe(200);
    expect(anaOwnProfile.body.target.value).toBe("Ana Gonzalez");

    // Jabellae's namespace still returns HIS profile, not ana's
    const jabellaeProfile = await read(JABELLAE_NS, "profile.name");
    expect(jabellaeProfile.body.target.value).toBe("J. Abella");

    // pablo does not exist in ana's namespace — she hasn't written him there
    const pabloInAnaNs = await read(ANA_NS, "contacts.pablo.name");
    expect(pabloInAnaNs.status).toBe(404);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. NRP ENVELOPE: every response carries a correct me:// address
  // ─────────────────────────────────────────────────────────────────────────────

  it("every GET response carries a correctly formed NRP envelope", async () => {
    // WHAT: Verify the NRP metadata on a read response.
    //       The envelope wraps every response with the full NRP context so any
    //       node in the mesh can understand what was requested and where it came from.
    //
    // HOW: The path resolver calls normalizeHttpRequestToMeTarget(req) which builds:
    //        nrp       = "me://jabellae.demo.local:read/profile.name"
    //        path      = "profile.name"      (dot notation, no leading slash)
    //        operation = "read"
    //        namespace.me = "jabellae.demo.local"
    //
    // WHY: The nrp field is how the mesh identifies, routes, and deduplicates requests.
    //      Every NRP-aware client can look at this field and know: "this response
    //      came from jabellae.demo.local, for the read operation on profile.name."
    //      Without this, cross-node forwarding and caching cannot work.

    const res = await read(JABELLAE_NS, "profile.name");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { target } = res.body;
    // Namespace is resolved from the Host header
    expect(target.namespace.me).toBe(JABELLAE_NS);
    // The NRP address encodes namespace + operation + path
    expect(target.nrp).toBe("me://jabellae.demo.local:read/profile.name");
    // Operation is "read" for a GET
    expect(target.operation).toBe("read");
    // Path is the dot-notation version (no leading slash) — this is the NRP path format
    expect(target.path).toBe("profile.name");
    // The value is the stored scalar
    expect(target.value).toBe("J. Abella");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. FULL SOCIAL GRAPH: read the whole contacts branch as a nested object
  // ─────────────────────────────────────────────────────────────────────────────

  it("reads the entire contacts branch — all three friends as a nested object", async () => {
    // WHAT: GET /contacts with Host: jabellae.demo.local returns ALL contacts.* data
    //       as a deeply nested object.
    //
    // HOW: readSemanticBranchForNamespace("jabellae.demo.local", "contacts") finds:
    //        contacts.ana.name, contacts.ana.age, contacts.ana.city
    //        contacts.pablo.name, contacts.pablo.age, contacts.pablo.city
    //        contacts.luisa.name, contacts.luisa.age, contacts.luisa.city
    //      And assembles:
    //        {
    //          ana:   { name: "Ana",   age: 22, city: "CDMX" },
    //          pablo: { name: "Pablo", age: 17, city: "Monterrey" },
    //          luisa: { name: "Luisa", age: 31, city: "Xalapa" },
    //        }
    //
    // WHY: This is the "whole graph in one call" pattern. A social app can fetch
    //      all of jabellae's known contacts in a single GET /contacts request.
    //      No pagination, no joins — the namespace IS the graph.

    const res = await read(JABELLAE_NS, "contacts");
    expect(res.status).toBe(200);
    expect(res.body.target.value).toMatchObject({
      ana: {
        name: "Ana",
        age: 22,
        city: "CDMX",
      },
      pablo: {
        name: "Pablo",
        age: 17,
        city: "Monterrey",
      },
      luisa: {
        name: "Luisa",
        age: 31,
        city: "Xalapa",
      },
    });
  });
});
