/**
 * Demos/socialGraph.demo.ts — Social Graph Over a Real Namespace
 *
 * Run with:  npx tsx tests/Demos/socialGraph.demo.ts
 *
 * Spins up a real monad Express server in-process, writes a social graph
 * over HTTP, then reads it back — leaf reads, branch reads, pointers,
 * and namespace isolation — printing every NRP envelope to stdout.
 */

import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createMonadApp } from "../../src/index.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";

const ROOT_NS     = "demo.local";
const JABELLAE_NS = "jabellae.demo.local";
const ANA_NS      = "ana.demo.local";

// ── helpers ───────────────────────────────────────────────────────────────────

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-social-demo-"));
  return {
    root,
    stateDir:       path.join(root, "state"),
    claimDir:       path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    routesPath:     path.join(root, "routes.js"),
    indexPath:      path.join(root, "index.html"),
  };
}

function ok(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    if (detail !== undefined) console.error("    got:", JSON.stringify(detail, null, 2));
    process.exitCode = 1;
  }
}

async function write(
  app: Awaited<ReturnType<typeof createMonadApp>>,
  namespace: string,
  pathStr: string,
  value: unknown,
  operator?: string,
) {
  const body: Record<string, unknown> = { path: pathStr, value };
  if (operator) body.operator = operator;
  const res = await request(app)
    .post("/")
    .set("Host", namespace)
    .set("Content-Type", "application/json")
    .send(body);
  return res;
}

async function read(
  app: Awaited<ReturnType<typeof createMonadApp>>,
  namespace: string,
  pathStr: string,
) {
  const urlPath = "/" + pathStr.replace(/\./g, "/");
  return request(app).get(urlPath).set("Host", namespace);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  resetKernelStateForTests();
  const runtime = tempRuntime();

  console.log("▶  Starting monad app …");
  const app = await createMonadApp({
    cwd:              runtime.root,
    seed:             "demo-social-graph-seed",
    namespace:        ROOT_NS,
    stateDir:         runtime.stateDir,
    claimDir:         runtime.claimDir,
    selfConfigPath:   runtime.selfConfigPath,
    selfIdentity:     ROOT_NS,
    selfHostname:     "demo.local",
    selfEndpoint:     "http://localhost:0",
    selfTags:         ["demo", "local"],
    port:             0,
    guiPkgDistDir:    runtime.root,
    mePkgDistDir:     runtime.root,
    cleakerPkgDistDir: runtime.root,
    reactUmdDir:      runtime.root,
    reactDomUmdDir:   runtime.root,
    routesPath:       runtime.routesPath,
    indexPath:        runtime.indexPath,
    logger:           false,
  });
  console.log("   app ready\n");

  // ── 1. Write jabellae's profile ────────────────────────────────────────────
  console.log("── 1. Write profile fields → jabellae.demo.local");
  await write(app, JABELLAE_NS, "profile.name", "J. Abella");
  await write(app, JABELLAE_NS, "profile.age",  28);
  await write(app, JABELLAE_NS, "profile.city", "Veracruz");

  const nameRes = await read(app, JABELLAE_NS, "profile.name");
  ok("profile.name → \"J. Abella\"",
    nameRes.body.target.value === "J. Abella", nameRes.body.target.value);
  ok("NRP envelope present",
    nameRes.body.target.nrp === "me://jabellae.demo.local:read/profile.name",
    nameRes.body.target.nrp);
  console.log(`   nrp: ${nameRes.body.target.nrp}\n`);

  // ── 2. Branch read: whole profile as one object ───────────────────────────
  console.log("── 2. Branch read → GET /profile");
  const profileRes = await read(app, JABELLAE_NS, "profile");
  const profile = profileRes.body.target.value;
  ok("profile.name = \"J. Abella\"", profile?.name === "J. Abella",    profile);
  ok("profile.age  = 28",            profile?.age  === 28,              profile);
  ok("profile.city = \"Veracruz\"",  profile?.city === "Veracruz",      profile);
  console.log("   value:", JSON.stringify(profile), "\n");

  // ── 3. Write social graph ─────────────────────────────────────────────────
  console.log("── 3. Write social graph — contacts.ana / pablo / luisa");
  await write(app, JABELLAE_NS, "contacts.ana.name",   "Ana");
  await write(app, JABELLAE_NS, "contacts.ana.age",    22);
  await write(app, JABELLAE_NS, "contacts.ana.city",   "CDMX");
  await write(app, JABELLAE_NS, "contacts.pablo.name", "Pablo");
  await write(app, JABELLAE_NS, "contacts.pablo.age",  17);
  await write(app, JABELLAE_NS, "contacts.pablo.city", "Monterrey");
  await write(app, JABELLAE_NS, "contacts.luisa.name", "Luisa");
  await write(app, JABELLAE_NS, "contacts.luisa.age",  31);
  await write(app, JABELLAE_NS, "contacts.luisa.city", "Xalapa");

  // Friend pointers: friends.X → contacts.X
  await write(app, JABELLAE_NS, "friends.ana",   "contacts.ana",   "->");
  await write(app, JABELLAE_NS, "friends.pablo", "contacts.pablo", "->");
  await write(app, JABELLAE_NS, "friends.luisa", "contacts.luisa", "->");

  const luisaCityRes = await read(app, JABELLAE_NS, "contacts.luisa.city");
  ok("contacts.luisa.city = \"Xalapa\"",
    luisaCityRes.body.target.value === "Xalapa", luisaCityRes.body.target.value);
  console.log();

  // ── 4. Branch read: a single contact node ─────────────────────────────────
  console.log("── 4. Branch read → GET /contacts/ana");
  const anaRes = await read(app, JABELLAE_NS, "contacts.ana");
  const ana = anaRes.body.target.value;
  ok("name = \"Ana\"",  ana?.name === "Ana",  ana);
  ok("age  = 22",       ana?.age  === 22,     ana);
  ok("city = \"CDMX\"", ana?.city === "CDMX", ana);
  console.log("   value:", JSON.stringify(ana), "\n");

  // ── 5. Full contacts branch ───────────────────────────────────────────────
  console.log("── 5. Branch read → GET /contacts  (entire social graph)");
  const contactsRes = await read(app, JABELLAE_NS, "contacts");
  const contacts = contactsRes.body.target.value;
  ok("contacts.ana.name   = \"Ana\"",      contacts?.ana?.name   === "Ana",       contacts);
  ok("contacts.pablo.city = \"Monterrey\"",contacts?.pablo?.city === "Monterrey", contacts);
  ok("contacts.luisa.age  = 31",           contacts?.luisa?.age  === 31,          contacts);
  console.log("   value:", JSON.stringify(contacts, null, 2), "\n");

  // ── 6. Pointer read ───────────────────────────────────────────────────────
  console.log("── 6. Pointer read → GET /friends/luisa");
  const ptrRes = await read(app, JABELLAE_NS, "friends.luisa");
  const ptr = ptrRes.body.target.value;
  ok("__ptr = \"contacts.luisa\"", ptr?.__ptr === "contacts.luisa", ptr);
  console.log("   value:", JSON.stringify(ptr), "\n");

  // ── 7. Namespace isolation ────────────────────────────────────────────────
  console.log("── 7. Namespace isolation — ana.demo.local cannot see jabellae's data");
  await write(app, ANA_NS, "profile.name", "Ana Gonzalez");
  const anaOwn     = await read(app, ANA_NS,      "profile.name");
  const jabellaeOwn= await read(app, JABELLAE_NS, "profile.name");
  const pabloInAna = await read(app, ANA_NS,      "contacts.pablo.name");
  ok("ana.demo.local profile.name = \"Ana Gonzalez\"",
    anaOwn.body.target.value === "Ana Gonzalez", anaOwn.body.target.value);
  ok("jabellae.demo.local profile.name still = \"J. Abella\"",
    jabellaeOwn.body.target.value === "J. Abella", jabellaeOwn.body.target.value);
  ok("pablo NOT visible from ana's namespace (404)",
    pabloInAna.status === 404, pabloInAna.status);
  console.log();

  // ── cleanup ───────────────────────────────────────────────────────────────
  resetKernelStateForTests();
  fs.rmSync(runtime.root, { recursive: true, force: true });

  console.log(process.exitCode === 1 ? "FAILED" : "All checks passed.");
}

main().catch((err) => { console.error(err); process.exit(1); });
