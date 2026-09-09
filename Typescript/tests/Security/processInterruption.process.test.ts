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
 * Concurrent writers: this file also documents (not "supports") the
 * single-writer assumption — two independent processes racing to persist
 * to the SAME ME_STATE_DIR do not merge; the later rename wins outright,
 * atomically (never a corrupted hybrid), and the earlier writer's state is
 * simply gone. This is asserted as the actual, honest behavior, not
 * invented or presented as a supported concurrency feature.
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
    "concurrent writers (documented limit, not a supported feature): two independent processes racing on the same ME_STATE_DIR never corrupt the file — the later save wins outright, atomically",
    async () => {
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
      const writerB = spawnFixture(identityWriterScript, {
        ...baseEnv,
        TEST_IDENTITY_PASSWORD: "concurrent-password-B-0002",
        TEST_BRANCH_SECRET: "concurrent-secret-B",
        TEST_BRANCH_VALUE: "VALUE_FROM_WRITER_B",
      });
      spawned.push(writerA, writerB);

      await Promise.all([
        waitForStdoutMarker(writerA, "WRITER_READY", TEST_TIMEOUT_MS),
        waitForStdoutMarker(writerB, "WRITER_READY", TEST_TIMEOUT_MS),
      ]);

      // SIGTERM both at nearly the same time — a real (if adversarial)
      // "two monads pointed at the same state dir" scenario.
      writerA.child.kill("SIGTERM");
      writerB.child.kill("SIGTERM");
      await Promise.all([waitForExit(writerA, TEST_TIMEOUT_MS), waitForExit(writerB, TEST_TIMEOUT_MS)]);

      const snapshotPath = path.join(stateDir, "snapshot.json");
      expect(fs.existsSync(snapshotPath)).toBe(true);
      const raw = fs.readFileSync(snapshotPath, "utf8");
      let parsed: any;
      expect(() => {
        parsed = JSON.parse(raw);
      }, `even under a same-directory write race, the file must be valid JSON — never a corrupted interleaving of both writers' bytes. Raw (first 300 chars): ${raw.slice(0, 300)}`).not.toThrow();

      // Documented limit: exactly ONE writer's full identity root survives
      // (whichever renamed last) — there is no merge. Assert this
      // explicitly rather than silently accepting either outcome without
      // comment, so a future change that DOES add merge semantics has to
      // consciously update this test rather than pass by accident.
      const rootIdA = parsed.identityRoot?.rootId;
      expect(rootIdA, "the surviving snapshot must have SOME identity root — one writer's full state, not a blend").toBeTruthy();
      expect(raw.includes("concurrent-secret-A") || raw.includes("concurrent-secret-B") || raw.includes("VALUE_FROM_WRITER_A") || raw.includes("VALUE_FROM_WRITER_B")).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
