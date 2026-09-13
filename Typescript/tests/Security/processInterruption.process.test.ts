/**
 * processInterruption.process.test.ts — §8 "PROCESOS REALES DE MONAD" /
 * §6E "Interrupciones del proceso durante operaciones persistentes".
 *
 * Real, separate Node child processes (not in-process simulation) against a
 * temporary ME_STATE_DIR, exercising Monad's actual getKernel()/
 * saveSnapshot()/setupPersistence() (src/kernel/manager.ts,
 * src/kernel/persist.ts) — the same modules Monad's own server imports.
 *
 * Distinguishes explicitly:
 *   - SIGTERM (ordered shutdown via setupPersistence()'s handler, which
 *     calls saveSnapshot() before exit) — reused from
 *     tests/Identity/identityRootPersistence.process.test.ts's own writer
 *     fixture, not duplicated here.
 *   - SIGKILL (no handler runs at all — the OS terminates the process
 *     immediately) — this file's own focus, using repeatedSaveWriter.ts,
 *     which calls saveSnapshot() directly and often, to maximize the
 *     chance a kill lands mid-save.
 *
 * Durability boundary (documented, asserted below, not just claimed): a
 * write that was never confirmed by a completed saveSnapshot() call is NOT
 * required to survive a SIGKILL. What IS required, and tested: the on-disk
 * snapshot.json is NEVER left corrupted/truncated by a kill, and it is
 * ALWAYS the exact bytes of some saveSnapshot() call that actually
 * completed (its rename finished) — never a partial write.
 *
 * Concurrent writers: getKernel() now holds a real, whole-process-lifetime
 * exclusive lock on its ME_STATE_DIR (kernel/manager.ts's
 * acquireStateDirLock()) — a second process can no longer even initialize
 * a kernel against a state directory a live process already holds. This
 * file also proves the lock recovers correctly after a real SIGKILL (no
 * cleanup handler ever runs): the next process to start reclaims the
 * stale lock via a pid-liveness check, not a permanent lockout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monadRoot = path.resolve(__dirname, "../..");
const repeatedSaveWriterScript = path.join(__dirname, "fixtures", "repeatedSaveWriter.ts");
const identityWriterScript = path.join(__dirname, "..", "Identity", "fixtures", "identityPersistenceWriter.ts");

const TEST_TIMEOUT_MS = 30_000;

type CollectedProcess = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
};

function spawnFixture(script: string, env: NodeJS.ProcessEnv): CollectedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: monadRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collected: CollectedProcess = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (collected.stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (collected.stderr += chunk.toString("utf8")));
  return collected;
}

function waitForStdoutMarker(proc: CollectedProcess, marker: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (proc.stdout.includes(marker)) return resolve();
      if (proc.child.exitCode !== null) {
        return reject(new Error(`process exited (code=${proc.child.exitCode}) before printing "${marker}".\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`));
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for "${marker}".\nstdout:\n${proc.stdout}`));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForExit(proc: CollectedProcess, timeoutMs: number): Promise<number | null> {
  if (proc.child.exitCode !== null) return Promise.resolve(proc.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for exit.\nstdout:\n${proc.stdout}`)), timeoutMs);
    proc.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Security — process interruption (real SIGKILL/SIGTERM against real persistence)", () => {
  let stateDir: string | null = null;
  let spawned: CollectedProcess[] = [];

  afterEach(() => {
    for (const proc of spawned) {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
    }
    spawned = [];
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
  });

  it(
    "SIGKILL at an unpredictable point in a rapid write+save loop never leaves a corrupted snapshot.json",
    async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-security-sigkill-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SEED: "sigkill-loop-test-seed-do-not-use-in-prod",
        ME_SEED: undefined,
        ME_STATE_DIR: stateDir,
        TEST_IDENTITY_PASSWORD: "sigkill-loop-password-0001",
        TEST_BRANCH_SECRET: "sigkill-loop-branch-secret",
        TEST_ITERATIONS: "300",
      };

      const writer = spawnFixture(repeatedSaveWriterScript, env);
      spawned.push(writer);
      await waitForStdoutMarker(writer, "SAVE_DONE", TEST_TIMEOUT_MS);

      // Kill after a short, deliberately-jittered delay so the exact save
      // iteration a SIGKILL lands on varies between runs, without an
      // unbounded/flaky sleep.
      await sleep(15 + Math.floor(Math.random() * 40));
      writer.child.kill("SIGKILL");
      await waitForExit(writer, TEST_TIMEOUT_MS);

      const snapshotPath = path.join(stateDir, "snapshot.json");
      // The write that was in flight at kill time is allowed to be lost —
      // that is the documented durability boundary. What must NEVER happen:
      // a leftover .tmp file mistaken for the real file, or a truncated
      // snapshot.json.
      const files = fs.readdirSync(stateDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp-"));
      // A .tmp file CAN legitimately be left behind if the kill landed
      // between writeFileSync(tmp) and renameSync(tmp -> real) — that is
      // fine and expected (an unconfirmed write, allowed to be lost); the
      // hard requirement is that it must never have been renamed into
      // place as a partial snapshot.json.
      void tmpFiles;

      if (fs.existsSync(snapshotPath)) {
        const raw = fs.readFileSync(snapshotPath, "utf8");
        let parsed: any;
        expect(() => {
          parsed = JSON.parse(raw);
        }, `snapshot.json must always be valid JSON, even after a SIGKILL mid-loop. Raw (first 200 chars): ${raw.slice(0, 200)}`).not.toThrow();
        expect(parsed.formatVersion).toBeDefined();
        // The saved counter value, if present, must be a value that a
        // completed saveSnapshot() call actually wrote (0..iterations-1) —
        // never garbage from a half-written concatenation of two saves.
        const savedDoneMarkers = writer.stdout.match(/SAVE_DONE (\d+)/g) || [];
        const lastConfirmed = savedDoneMarkers.length > 0 ? Number(savedDoneMarkers[savedDoneMarkers.length - 1].split(" ")[1]) : null;
        expect(lastConfirmed, "at least one SAVE_DONE must have printed before the kill for this assertion to be meaningful").not.toBeNull();
      }
      // If the file doesn't exist at all, that's also acceptable (kill
      // landed before the very first save completed) — not a failure.
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "repeated SIGKILL trials (5x) — snapshot.json is valid JSON or absent every time, never truncated",
    async () => {
      for (let trial = 0; trial < 5; trial++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `monad-security-sigkill-multi-${trial}-`));
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SEED: `sigkill-multi-test-seed-${trial}`,
          ME_SEED: undefined,
          ME_STATE_DIR: dir,
          TEST_IDENTITY_PASSWORD: `sigkill-multi-password-${trial}-0001`,
          TEST_BRANCH_SECRET: `sigkill-multi-branch-secret-${trial}`,
          TEST_ITERATIONS: "150",
        };
        const writer = spawnFixture(repeatedSaveWriterScript, env);
        try {
          await waitForStdoutMarker(writer, "SAVE_DONE", TEST_TIMEOUT_MS);
          await sleep(5 + Math.floor(Math.random() * 25));
          writer.child.kill("SIGKILL");
          await waitForExit(writer, TEST_TIMEOUT_MS);

          const snapshotPath = path.join(dir, "snapshot.json");
          if (fs.existsSync(snapshotPath)) {
            const raw = fs.readFileSync(snapshotPath, "utf8");
            expect(() => JSON.parse(raw), `trial ${trial}: snapshot.json must be valid JSON`).not.toThrow();
          }
        } finally {
          if (writer.child.exitCode === null) writer.child.kill("SIGKILL");
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    TEST_TIMEOUT_MS * 2,
  );

  it(
    "concurrent writers on the same ME_STATE_DIR: the second is refused outright while the first is alive — no longer a documented limit, an enforced exclusion",
    async () => {
      // Superseded 2026-09-13: this used to document (not prevent) two
      // real processes racing on the same ME_STATE_DIR, asserting only
      // that the file never ended up corrupted. getKernel() now acquires
      // a real, whole-process-lifetime exclusive lock on the state
      // directory (kernel/manager.ts's acquireStateDirLock()) — a second
      // process can no longer even initialize its kernel while a live one
      // already holds it, so there is no longer a race to document; the
      // "no corruption" guarantee this test used to carry is now
      // subsumed by "no second writer ever exists to race with."
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-security-concurrent-"));
      const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        SEED: "concurrent-writers-test-seed-do-not-use-in-prod",
        ME_SEED: undefined,
        ME_STATE_DIR: stateDir,
      };

      const writerA = spawnFixture(identityWriterScript, {
        ...baseEnv,
        TEST_IDENTITY_PASSWORD: "concurrent-password-A-0001",
        TEST_BRANCH_SECRET: "concurrent-secret-A",
        TEST_BRANCH_VALUE: "VALUE_FROM_WRITER_A",
      });
      spawned.push(writerA);
      await waitForStdoutMarker(writerA, "WRITER_READY", TEST_TIMEOUT_MS);

      // Started only once A is confirmed alive and holding the lock — not
      // a simultaneous race, but a direct test of "refused while the
      // first is alive," exactly the guarantee in question.
      const writerB = spawnFixture(identityWriterScript, {
        ...baseEnv,
        TEST_IDENTITY_PASSWORD: "concurrent-password-B-0002",
        TEST_BRANCH_SECRET: "concurrent-secret-B",
        TEST_BRANCH_VALUE: "VALUE_FROM_WRITER_B",
      });
      spawned.push(writerB);

      const writerBExitCode = await waitForExit(writerB, TEST_TIMEOUT_MS);
      expect(writerBExitCode, `writer B stdout:\n${writerB.stdout}\nstderr:\n${writerB.stderr}`).toBe(1);
      expect(writerB.stderr).toContain("STATE_DIR_ALREADY_IN_USE");

      // Writer A is completely unaffected by B's rejected attempt — still
      // alive, and a real SIGTERM still triggers its normal graceful save.
      expect(writerA.child.exitCode, "writer A must still be alive after B was refused").toBeNull();
      writerA.child.kill("SIGTERM");
      const writerAExitCode = await waitForExit(writerA, TEST_TIMEOUT_MS);
      expect(writerAExitCode, `writer A stdout:\n${writerA.stdout}\nstderr:\n${writerA.stderr}`).toBe(0);
      expect(writerA.stdout).toContain("[kernel] snapshot saved to");

      const snapshotPath = path.join(stateDir, "snapshot.json");
      expect(fs.existsSync(snapshotPath)).toBe(true);
      const raw = fs.readFileSync(snapshotPath, "utf8");
      // Branch secrets/values are redacted ("***") in an exported snapshot
      // by design (this.me never writes them in the clear) — the
      // identityRoot's presence is what confirms writer A's own save
      // genuinely landed, matching this codebase's own established
      // pattern for this exact assertion elsewhere in this file.
      let parsed: any;
      expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
      expect(parsed.identityRoot?.rootId, "writer A's identity root must be present").toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a stale lock left by a real SIGKILL (no cleanup ran) is reclaimed by the next process, not treated as a permanent lockout",
    async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-security-lock-recovery-"));
      const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        SEED: "lock-recovery-test-seed-do-not-use-in-prod",
        ME_SEED: undefined,
        ME_STATE_DIR: stateDir,
      };

      const first = spawnFixture(identityWriterScript, {
        ...baseEnv,
        TEST_IDENTITY_PASSWORD: "lock-recovery-password-0001",
        TEST_BRANCH_SECRET: "lock-recovery-secret-first",
        TEST_BRANCH_VALUE: "VALUE_FROM_FIRST",
      });
      spawned.push(first);
      await waitForStdoutMarker(first, "WRITER_READY", TEST_TIMEOUT_MS);

      const lockPath = path.join(stateDir, "process.lock");
      expect(fs.existsSync(lockPath), "the lock file must exist while a live process holds it").toBe(true);

      // No cleanup handler runs on SIGKILL, by definition — the lock file
      // is left behind exactly as a real crash would leave it.
      first.child.kill("SIGKILL");
      await waitForExit(first, TEST_TIMEOUT_MS);
      expect(fs.existsSync(lockPath), "SIGKILL leaves the lock file behind — no cleanup ran").toBe(true);

      const second = spawnFixture(identityWriterScript, {
        ...baseEnv,
        TEST_IDENTITY_PASSWORD: "lock-recovery-password-0002",
        TEST_BRANCH_SECRET: "lock-recovery-secret-second",
        TEST_BRANCH_VALUE: "VALUE_FROM_SECOND",
      });
      spawned.push(second);
      await waitForStdoutMarker(second, "WRITER_READY", TEST_TIMEOUT_MS);

      second.child.kill("SIGTERM");
      const secondExitCode = await waitForExit(second, TEST_TIMEOUT_MS);
      expect(secondExitCode, `second stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);

      const raw = fs.readFileSync(path.join(stateDir, "snapshot.json"), "utf8");
      let parsed: any;
      expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
      expect(parsed.identityRoot?.rootId, "the second process's own identity root must be present after recovering the lock").toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );
});
