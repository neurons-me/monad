/**
 * Demos/mesh.demo.ts — Monad Mesh Resolution
 *
 * Run with:  npx tsx tests/Demos/mesh.demo.ts
 *
 * THE STORY:
 * In the real monad mesh, each monad is an autonomous node that owns one or
 * more namespaces.  When alice's monad receives a request for bob.local data,
 * it does NOT return 404.  Instead its bridge layer:
 *   1. Looks up all monads claiming bob.local in the mesh index.
 *   2. Scores them (latency × recency × resonance) using adaptive weights.
 *   3. Forwards the request to the winner.
 *   4. Returns the response annotated with _mesh routing metadata.
 *   5. Records the outcome and nudges the weights for next time.
 *
 * IN THIS DEMO:
 *   alice.local  — full monad (createMonadApp), no port, accessed via supertest
 *   bob-primary  — minimal monad-compatible server, listening on an OS-assigned port
 *   bob-backup   — second claimant for bob.local, also on an OS-assigned port
 *
 * Both bobs are seeded into alice's kernel mesh index.  Alice's bridge
 * discovers them, scores them, and forwards.  The _mesh envelope proves
 * which server was chosen and with what score.
 *
 * ACT 1 — Each namespace serves its own data
 * ACT 2 — The mesh: who alice knows about
 * ACT 3 — Cross-monad bridge resolution (alice → bob)
 * ACT 4 — Branch read across the mesh (whole profile object)
 * ACT 5 — Adaptive scoring: weights shift after successful forwards
 */

import express from "express";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import request from "supertest";
import { createMonadApp } from "../../src/index.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry } from "../../src/kernel/monadIndex.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mesh-demo-"));
  return {
    root,
    stateDir:       path.join(root, "state"),
    claimDir:       path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    routesPath:     path.join(root, "routes.js"),
    indexPath:      path.join(root, "index.html"),
  };
}

function setNestedPath(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  if (keys.length === 0) return;
  if (keys.length === 1) { obj[keys[0]!] = value; return; }
  const key = keys[0]!;
  if (!obj[key] || typeof obj[key] !== "object") obj[key] = {};
  setNestedPath(obj[key] as Record<string, unknown>, keys.slice(1), value);
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

function getPort(server: http.Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

// ── Bob's minimal monad-compatible server ────────────────────────────────────
//
// A real HTTP server that stores semantic data and returns NRP envelopes.
// Does NOT use the monad kernel — no kernel reset side-effects.
//
// Response format puts `value` at the TOP LEVEL so the bridge patching
// ({ ...payload, target: bridgeTarget, _mesh }) preserves it.
// (The bridge overwrites `target` but leaves top-level `value` intact.)

function createBobApp(monadName: string, namespace: string, data: Record<string, unknown>) {
  const app = express();
  app.use(express.json());

  app.get("*", (req, res) => {
    // Bridge forwards with Host: <namespace> and x-forwarded-host
    const host = String(
      req.headers["x-forwarded-host"] || req.headers.host || namespace
    ).split(",")[0]?.trim() || namespace;

    const pathDot = req.path
      .slice(1)
      .replace(/\//g, ".")
      .replace(/^\.+|\.+$/g, "") || "_";

    const nrp = `me://${host}:read/${pathDot}`;

    // Exact leaf match
    let value: unknown = data[pathDot];

    // Branch match — assemble all paths under this prefix into a nested object
    if (value === undefined && pathDot !== "_") {
      const prefix = pathDot + ".";
      const branch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith(prefix)) {
          setNestedPath(branch, k.slice(prefix.length).split("."), v);
        }
      }
      if (Object.keys(branch).length > 0) value = branch;
    }

    if (value === undefined) {
      return res.status(404).json({
        ok: false,
        target: { namespace: { me: host }, nrp, path: pathDot, operation: "read" },
        error: "NOT_FOUND",
      });
    }

    // value at TOP LEVEL: survives `{ ...payload, target: bridgeTarget }` patching.
    // value inside target: matches the standard NRP envelope format.
    res.json({
      ok: true,
      value,
      target: {
        namespace: { me: host, host },
        nrp,
        path: pathDot,
        operation: "read",
        value,
      },
      _monad: monadName,
    });
  });

  return app;
}

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("▶  mesh.demo.ts — Monad Mesh Resolution");
  console.log("   Two monads, real HTTP, adaptive scoring\n");

  resetKernelStateForTests();
  const runtime = tempRuntime();

  // ── Boot alice's monad ───────────────────────────────────────────────────
  process.stdout.write("▶  Starting alice.local monad ... ");
  const alice = await createMonadApp({
    cwd:               runtime.root,
    seed:              "mesh-demo-alice-seed",
    namespace:         "alice.local",
    stateDir:          runtime.stateDir,
    claimDir:          runtime.claimDir,
    selfConfigPath:    runtime.selfConfigPath,
    selfIdentity:      "alice.local",
    selfHostname:      "alice.local",
    selfEndpoint:      "http://localhost:0",
    selfTags:          ["demo", "alice.local"],
    port:              0,
    guiPkgDistDir:     runtime.root,
    mePkgDistDir:      runtime.root,
    cleakerPkgDistDir: runtime.root,
    reactUmdDir:       runtime.root,
    reactDomUmdDir:    runtime.root,
    routesPath:        runtime.routesPath,
    indexPath:         runtime.indexPath,
    logger:            false,
  });
  console.log("ready");

  // ── Write alice's profile into her own namespace ─────────────────────────
  await request(alice).post("/").set("Host", "alice.local")
    .set("Content-Type", "application/json")
    .send({ path: "profile.name", value: "J. Abella" });
  await request(alice).post("/").set("Host", "alice.local")
    .set("Content-Type", "application/json")
    .send({ path: "profile.age", value: 28 });
  await request(alice).post("/").set("Host", "alice.local")
    .set("Content-Type", "application/json")
    .send({ path: "profile.city", value: "Veracruz" });

  // ── Boot the two Bob servers ─────────────────────────────────────────────
  const BOB_DATA: Record<string, unknown> = {
    "profile.name": "Bob Smith",
    "profile.age":  34,
    "profile.city": "Guadalajara",
    "status":       "online",
  };

  process.stdout.write("▶  Starting bob-primary ... ");
  const bobPrimaryServer = await startServer(createBobApp("bob-primary", "bob.local", BOB_DATA));
  const portPrimary = getPort(bobPrimaryServer);
  console.log(`ready (port ${portPrimary})`);

  process.stdout.write("▶  Starting bob-backup  ... ");
  const bobBackupServer  = await startServer(createBobApp("bob-backup",  "bob.local", BOB_DATA));
  const portBackup  = getPort(bobBackupServer);
  console.log(`ready (port ${portBackup})`);

  // ── Seed both bobs into alice's kernel mesh index ───────────────────────
  // Alice's bridge calls findMonadsForNamespaceAsync("bob.local") which reads
  // the kernel index.  writeMonadIndexEntry writes while alice's kernel is
  // active (right after createMonadApp initialized it).
  const now = Date.now();
  writeMonadIndexEntry({
    monad_id:           "bob-primary",
    name:               "bob-primary",
    namespace:          "bob.local",
    endpoint:           `http://127.0.0.1:${portPrimary}`,
    tags:               ["bob.local", "primary"],
    claimed_namespaces: ["bob.local"],
    first_seen:         now,
    last_seen:          now,
  });
  writeMonadIndexEntry({
    monad_id:           "bob-backup",
    name:               "bob-backup",
    namespace:          "bob.local",
    endpoint:           `http://127.0.0.1:${portBackup}`,
    tags:               ["bob.local", "backup"],
    claimed_namespaces: ["bob.local"],
    first_seen:         now - 5000,
    last_seen:          now - 5000,   // slightly less fresh → slightly lower score
  });
  console.log("   ✓ Seeded bob-primary and bob-backup into alice's mesh index\n");

  // ════════════════════════════════════════════════════════════════════════
  //  ACT 1 — Each monad serves its own namespace
  // ════════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("── Act 1: Each monad serves its own namespace");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // alice serves her own namespace directly
  const aliceName = await request(alice).get("/profile/name").set("Host", "alice.local");
  ok(`alice.local/profile.name = "J. Abella"`,
    aliceName.body.target?.value === "J. Abella", aliceName.body.target?.value);
  console.log(`   nrp:   ${aliceName.body.target?.nrp}`);
  console.log(`   value: ${JSON.stringify(aliceName.body.target?.value)}\n`);

  // alice branch read
  const aliceProfile = await request(alice).get("/profile").set("Host", "alice.local");
  const ap = aliceProfile.body.target?.value;
  ok("alice.local/profile (branch) = { name, age, city }",
    ap?.name === "J. Abella" && ap?.age === 28 && ap?.city === "Veracruz", ap);
  console.log("   value:", JSON.stringify(ap), "\n");

  // bob serves his own namespace from his own server
  // (use supertest with a URL string so Host header is forwarded correctly)
  const bobDirectBody = (
    await request(`http://127.0.0.1:${portPrimary}`)
      .get("/profile/name")
      .set("Host", "bob.local")
  ).body;
  ok(`bob.local/profile.name = "Bob Smith" (direct to bob-primary)`,
    bobDirectBody.value === "Bob Smith", bobDirectBody.value);
  console.log(`   nrp:   ${bobDirectBody.target?.nrp}`);
  console.log(`   value: ${JSON.stringify(bobDirectBody.value)}\n`);

  // ════════════════════════════════════════════════════════════════════════
  //  ACT 2 — The mesh: who alice knows about
  // ════════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("── Act 2: The mesh — who alice knows about");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // List all monads in alice's mesh index
  const meshMonads = await request(alice).get("/.mesh/monads");
  const monads: any[] = meshMonads.body.monads ?? [];
  ok(`alice's mesh index has ≥ 2 entries`, monads.length >= 2, monads.map((m: any) => m.monad_id));
  console.log("   known monads:");
  for (const m of monads) {
    console.log(`     ${m.monad_id.padEnd(16)} endpoint=${m.endpoint}  ns=${m.namespace}`);
  }
  console.log();

  // Resolve bob.local candidates
  const meshResolve = await request(alice).get("/.mesh/resolve?namespace=bob.local");
  const candidates: any[] = meshResolve.body.monads ?? [];
  ok(`2 monads claim bob.local`, candidates.length === 2, candidates.map((m: any) => m.monad_id));
  console.log("   candidates for bob.local:");
  for (const c of candidates) {
    console.log(`     ${c.monad_id.padEnd(16)} endpoint=${c.endpoint}`);
  }
  console.log();

  // ════════════════════════════════════════════════════════════════════════
  //  ACT 3 — Cross-monad bridge resolution
  //  alice.local bridge → scores candidates → forwards to winner → _mesh
  // ════════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("── Act 3: Cross-monad bridge resolution");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("   alice.local → bridge → me://bob.local:read/profile.name\n");

  const bridgeRes = await request(alice)
    .get("/resolve?target=me://bob.local:read/profile.name")
    .set("Host", "alice.local");

  const mesh = bridgeRes.body._mesh;
  ok("bridge routed to a bob server",
    mesh?.origin?.includes("127.0.0.1"), mesh?.origin);
  ok("hops = 1 (single forward)",
    mesh?.hops === 1, mesh?.hops);
  ok("reason = mesh-claim (scored selection)",
    mesh?.reason === "mesh-claim", mesh?.reason);
  ok(`value = "Bob Smith" (top-level, preserved through bridge patching)`,
    bridgeRes.body.value === "Bob Smith", bridgeRes.body.value);

  const winnerPort = new URL(mesh?.origin ?? "http://x").port;
  const winnerName = winnerPort === String(portPrimary) ? "bob-primary" : "bob-backup";
  const loserName  = winnerPort === String(portPrimary) ? "bob-backup"  : "bob-primary";

  console.log("\n   _mesh routing envelope:");
  console.log(`     origin:   ${mesh?.origin}`);
  console.log(`     monad_id: ${mesh?.monad_id}  ← winner`);
  console.log(`     score:    ${mesh?.score?.toFixed(4)}`);
  console.log(`     reason:   ${mesh?.reason}`);
  console.log(`     hops:     ${mesh?.hops}`);
  console.log(`\n   ${winnerName} won (more recent last_seen → higher recency score)`);
  console.log(`   ${loserName} was the runner-up\n`);

  // ════════════════════════════════════════════════════════════════════════
  //  ACT 4 — Branch read across the mesh
  //  GET /resolve?target=me://bob.local:read/profile
  //  → bridge forwards GET /profile to bob → bob assembles {name,age,city}
  // ════════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("── Act 4: Branch read across the mesh");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("   alice → bridge → me://bob.local:read/profile\n");

  const bridgeBranch = await request(alice)
    .get("/resolve?target=me://bob.local:read/profile")
    .set("Host", "alice.local");

  const bobProfile = bridgeBranch.body.value;
  ok("branch value.name = \"Bob Smith\"",  bobProfile?.name === "Bob Smith",  bobProfile);
  ok("branch value.age  = 34",             bobProfile?.age  === 34,            bobProfile);
  ok("branch value.city = \"Guadalajara\"",bobProfile?.city === "Guadalajara", bobProfile);
  console.log("   value:", JSON.stringify(bobProfile));
  console.log(`   _mesh.origin: ${bridgeBranch.body._mesh?.origin}\n`);

  // ════════════════════════════════════════════════════════════════════════
  //  ACT 5 — Adaptive scoring: weights shift after successful forwards
  //
  //  Each successful forward increments the resonance scorer in the adaptive
  //  weight store.  The bridge records the decision, correlates the outcome,
  //  and updates the weights.  GET /.mesh/weights shows the shift.
  // ════════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("── Act 5: Adaptive scoring — weights evolve with traffic");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Weights before  — response shape: { ok, current, defaults, delta, updateCount, ... }
  const weightsBefore = await request(alice).get("/.mesh/weights");
  const wBefore = weightsBefore.body.current ?? {};

  // Make 8 more bridge requests to accumulate learning signal
  process.stdout.write("   Making 8 bridge requests to generate learning signal ...");
  for (let i = 0; i < 8; i++) {
    await request(alice)
      .get("/resolve?target=me://bob.local:read/status")
      .set("Host", "alice.local");
  }
  console.log(" done\n");

  // Weights after
  const weightsAfter = await request(alice).get("/.mesh/weights");
  const wAfter = weightsAfter.body.current ?? {};

  console.log("   Scorer weights (resonance · recency · latency):");
  console.log(`     Before: resonance=${wBefore.resonance?.toFixed(5) ?? "?"}`
    + `  recency=${wBefore.recency?.toFixed(5) ?? "?"}`
    + `  latency=${wBefore.latency?.toFixed(5) ?? "?"}`);
  console.log(`     After:  resonance=${wAfter.resonance?.toFixed(5) ?? "?"}`
    + `  recency=${wAfter.recency?.toFixed(5) ?? "?"}`
    + `  latency=${wAfter.latency?.toFixed(5) ?? "?"}`);

  const rDelta = (wAfter.resonance ?? 0) - (wBefore.resonance ?? 0);
  const shifted = Math.abs(rDelta) > 1e-6;
  ok("weights shifted after successful forwards (resonance Δ > 0)", shifted,
    { before: wBefore.resonance, after: wAfter.resonance, delta: rDelta });

  console.log(`\n   resonance Δ = ${rDelta >= 0 ? "+" : ""}${rDelta.toFixed(6)}`);
  console.log(`   Each successful forward nudges resonance upward.`);
  console.log(`   Over hundreds of requests the mesh self-tunes to your actual traffic.\n`);

  // ── Mesh weights for bob.local namespace (blended with global) ───────────
  const weightsNs = await request(alice).get("/.mesh/weights?namespace=bob.local");
  const wNs = weightsNs.body.namespace?.blended ?? {};
  if (Object.keys(wNs).length > 0) {
    console.log("   Namespace-blended weights for bob.local:");
    console.log(`     resonance=${wNs.resonance?.toFixed(5) ?? "?"}  `
      + `recency=${wNs.recency?.toFixed(5) ?? "?"}  `
      + `latency=${wNs.latency?.toFixed(5) ?? "?"}`);
    console.log(`   (blended = global × (1-maturity) + namespace-local × maturity)\n`);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  resetKernelStateForTests();
  bobPrimaryServer.close();
  bobBackupServer.close();
  fs.rmSync(runtime.root, { recursive: true, force: true });

  console.log(process.exitCode === 1 ? "FAILED" : "All checks passed.");
}

main().catch((err) => { console.error(err); process.exit(1); });
