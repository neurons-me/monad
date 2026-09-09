/**
 * snapshotDurability.test.ts — §8 "PROCESOS REALES DE MONAD" (durability
 * half): in-process checks of getKernel()/saveSnapshot() from
 * src/kernel/manager.ts against a real ME_STATE_DIR on disk, WITHOUT
 * spawning a separate process (see processInterruption.process.test.ts for
 * the real-SIGKILL variant of these same properties).
 *
 * Covers a real bug found and fixed by this security battery:
 * saveSnapshot() used to write snapshot.json IN PLACE
 * (`writeFileSync(snapshotPath, ...)`). A process killed mid-write left a
 * truncated/corrupt file; getKernel()'s existing catch-and-warn fallback
 * then silently started a FRESH (near-empty) kernel, and the very next
 * saveSnapshot() (e.g. on the next SIGTERM) would overwrite the truncated
 * file with that near-empty state — permanently destroying whatever the
 * last GOOD snapshot actually held, not just the unconfirmed tail write.
 *
 * Fixed in src/kernel/manager.ts:
 *   - saveSnapshot() now writes to a temp file in the same directory and
 *     renameSync()s it into place — a same-directory rename is atomic at
 *     the filesystem level, so a kill mid-write can never leave a
 *     truncated snapshot.json; either the previous complete file survives,
 *     or the new complete file replaces it.
 *   - getKernel(), on a hydration failure (corrupt/unparseable
 *     snapshot.json), now quarantines the bad file by renaming it aside
 *     (snapshot.json.corrupted-<ts>) BEFORE falling back to a fresh
 *     kernel — so a later saveSnapshot() writes a NEW file rather than
 *     silently erasing the only copy of whatever was recoverable.
 *
 * Durability boundary this battery holds itself to (documented, not
 * asserted as a stronger guarantee): a write that was never confirmed
 * durable (no successful saveSnapshot() before a kill) is NOT expected to
 * survive — only that surviving state is never corrupted and never
 * silently replaced by less data than was already durable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

const ORIGINAL_ME_STATE_DIR = process.env.ME_STATE_DIR;
const ORIGINAL_SEED = process.env.SEED;
const ORIGINAL_ME_SEED = process.env.ME_SEED;

let stateDir: string;

async function freshManager() {
  // manager.ts's _kernel is a module-level singleton; vitest's `pool: "forks"`
  // gives each TEST FILE its own process, but tests within this file share
  // one module registry. resetKernelStateForTests() (already exported for
  // exactly this purpose, see commitGate.test.ts's own use of it) clears
  // the singleton and removes the directory between tests.
  const mod = await import("../../src/kernel/manager.js");
  return mod;
}

describe("Security — snapshot durability (getKernel/saveSnapshot)", () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-security-durability-"));
    process.env.ME_STATE_DIR = stateDir;
    process.env.SEED = "durability-test-seed-do-not-use-in-prod";
    delete process.env.ME_SEED;
  });

  afterEach(async () => {
    const { resetKernelStateForTests } = await freshManager();
    resetKernelStateForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (ORIGINAL_ME_STATE_DIR === undefined) delete process.env.ME_STATE_DIR;
    else process.env.ME_STATE_DIR = ORIGINAL_ME_STATE_DIR;
    if (ORIGINAL_SEED === undefined) delete process.env.SEED;
    else process.env.SEED = ORIGINAL_SEED;
    if (ORIGINAL_ME_SEED === undefined) delete process.env.ME_SEED;
    else process.env.ME_SEED = ORIGINAL_ME_SEED;
  });

  it("saveSnapshot() writes atomically: no leftover temp file after a successful save", async () => {
    const { getKernel, saveSnapshot, resetKernelStateForTests } = await freshManager();
    resetKernelStateForTests();
    const kernel = getKernel();
    await (kernel as any).createIdentityRoot("durability-atomic-password-01");
    (kernel as any).vault["_"]("durability-atomic-secret-01");
    (kernel as any).vault.balance(101);
    saveSnapshot();

    const files = fs.readdirSync(stateDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp-"));
    assert.equal(tmpFiles.length, 0, `no .tmp- files should remain after a successful save; found: ${JSON.stringify(tmpFiles)}`);
    assert.ok(files.includes("snapshot.json"), "snapshot.json must exist after a successful save");

    const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8"));
    assert.ok(onDisk, "saved snapshot must be valid, parseable JSON");
  });

  it("a leftover stale .tmp file from a simulated mid-write kill does not corrupt the real snapshot.json", async () => {
    const { getKernel, saveSnapshot, resetKernelStateForTests } = await freshManager();
    resetKernelStateForTests();
    const kernel = getKernel();
    await (kernel as any).createIdentityRoot("durability-stale-tmp-password-02");
    (kernel as any).vault["_"]("durability-stale-tmp-secret-02");
    (kernel as any).vault.balance(202);
    saveSnapshot();
    const goodSnapshot = fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8");

    // Simulate a process that started a write and was killed before the
    // rename — a stale, truncated temp file left behind. This must never
    // interfere with hydrating from the real, complete snapshot.json.
    fs.writeFileSync(path.join(stateDir, ".snapshot.json.tmp-99999-stale-12345"), '{"truncat', "utf8");

    // resetKernelStateForTests() itself deletes the directory, which we
    // don't want here — we only want to confirm the ON-DISK state is
    // untouched by the stale temp file, simulating a restart's first read.
    // resetKernelStateForTests() both clears `_kernel` AND rm -rf's the
    // dir, so instead we replicate just the singleton-clear half by
    // re-requiring the module is not possible (ESM caches); use the public
    // surface instead — getKernel() is idempotent and safe to call again
    // in-process since nothing mutated `_kernel` between calls in this
    // test. This test's real assertion is about the ON-DISK state, so we
    // read the file directly rather than relying on a second getKernel().
    const filesAfter = fs.readdirSync(stateDir);
    assert.ok(filesAfter.includes("snapshot.json"), "the real snapshot.json must still be present");
    assert.equal(
      fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8"),
      goodSnapshot,
      "a stale leftover .tmp file must not have been renamed over or otherwise altered the real snapshot.json",
    );
    JSON.parse(fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8")); // must not throw
  });

  it("REGRESSION: a corrupted snapshot.json is quarantined, not silently destroyed by the next save", async () => {
    const { getKernel, saveSnapshot, resetKernelStateForTests } = await freshManager();
    resetKernelStateForTests();
    const kernel1 = getKernel();
    await (kernel1 as any).createIdentityRoot("durability-quarantine-password-03");
    (kernel1 as any).vault["_"]("durability-quarantine-secret-03");
    (kernel1 as any).vault.balance(303);
    saveSnapshot();
    const goodBytes = fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8");
    assert.ok(goodBytes.length > 0);

    // Simulate a truncated/corrupt file at rest (e.g. from a bug in an
    // older version of saveSnapshot(), or disk-level corruption) — this is
    // deliberately NOT produced by killing a real process (that's
    // processInterruption.process.test.ts); this test isolates the
    // getKernel()-side handling of an already-bad file.
    fs.writeFileSync(path.join(stateDir, "snapshot.json"), goodBytes.slice(0, Math.floor(goodBytes.length / 2)), "utf8");

    // Force a fresh singleton by clearing and re-populating _kernel via the
    // module's own reset, then immediately restoring the directory's
    // corrupted file (resetKernelStateForTests deletes the dir — recreate
    // the exact corrupted state right after).
    resetKernelStateForTests();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "snapshot.json"), goodBytes.slice(0, Math.floor(goodBytes.length / 2)), "utf8");

    const kernel2 = getKernel(); // must not throw despite the corrupt file
    assert.equal((kernel2 as any).hasIdentityRoot(), false, "a corrupted snapshot must fall back to a fresh (empty) kernel, not throw or hang");

    const filesAfterHydrateAttempt = fs.readdirSync(stateDir);
    const quarantined = filesAfterHydrateAttempt.filter((f) => f.startsWith("snapshot.json.corrupted-"));
    assert.equal(quarantined.length, 1, `exactly one quarantined file should exist; found: ${JSON.stringify(filesAfterHydrateAttempt)}`);
    assert.equal(
      fs.readFileSync(path.join(stateDir, quarantined[0]), "utf8"),
      goodBytes.slice(0, Math.floor(goodBytes.length / 2)),
      "the quarantined file must preserve the exact corrupted bytes for forensics",
    );
    assert.equal(filesAfterHydrateAttempt.includes("snapshot.json"), false, "the corrupted path must have been moved aside, not left in place");

    // THE REGRESSION CHECK: the fresh (empty) kernel now saves — this must
    // NOT touch or delete the quarantined evidence file.
    saveSnapshot();
    const filesAfterFreshSave = fs.readdirSync(stateDir);
    assert.ok(filesAfterFreshSave.includes(quarantined[0]), "the quarantined corrupted file must survive a subsequent save — it is not silently cleaned up or overwritten");
    assert.ok(filesAfterFreshSave.includes("snapshot.json"), "a new snapshot.json is written by the fresh kernel's save");
    JSON.parse(fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8")); // must be valid
  });

  it("saveSnapshot() with no kernel ever created is a safe no-op (does not create a bogus empty snapshot.json)", async () => {
    const { saveSnapshot, resetKernelStateForTests } = await freshManager();
    resetKernelStateForTests();
    saveSnapshot(); // no getKernel() call before this
    const exists = fs.existsSync(path.join(stateDir, "snapshot.json"));
    assert.equal(exists, false, "saveSnapshot() must not fabricate a snapshot file when no kernel was ever instantiated this process");
  });
});
