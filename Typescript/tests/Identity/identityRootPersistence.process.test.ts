/**
 * identityRootPersistence.process.test.ts
 *
 * Proves Identity-Bound Secrets (me/Typescript/typedocs/Identity-Bound-Secrets.md)
 * actually round-trips through Monad's REAL process lifecycle and REAL
 * persistence code — not a reproduction of `.me`'s kernel API called
 * in-process (that's what the previous phase of this work did, and it's
 * explicitly not sufficient: see the doc's former §9.2).
 *
 * This spawns two genuinely separate Node child processes (via `tsx`,
 * fixtures under ./fixtures/):
 *
 *   1. identityPersistenceWriter.ts — calls Monad's real getKernel() (from
 *      src/kernel/manager.ts) and setupPersistence() (from
 *      src/kernel/persist.ts), creates an identity root, writes a
 *      branch-protected value, then stays alive until this test sends it
 *      SIGTERM — exercising the actual production graceful-shutdown save
 *      path (saveSnapshot() called from the SIGTERM handler), not a manual
 *      save-then-clean-exit stand-in for it.
 *
 *   2. identityPersistenceReader.ts — a FRESH process (its own empty
 *      `_kernel` module singleton) pointed at the same ME_STATE_DIR. Calls
 *      the same real getKernel(), which hydrates from the writer's
 *      persisted snapshot.json exactly like a restarted monad.ai process
 *      does, then unlocks the identity root and resupplies the branch
 *      secret directly on the kernel object (Monad has no HTTP route for
 *      this yet — out of scope per the task) and confirms the exact
 *      original value comes back.
 *
 * Both child processes import `../../../src/kernel/manager.ts` directly —
 * the identical module Monad's own HTTP handlers import — so this is
 * Monad's real code path, run through a real process boundary, not a
 * simulation of it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monadRoot = path.resolve(__dirname, "../..");
const writerScript = path.join(__dirname, "fixtures", "identityPersistenceWriter.ts");
const readerScript = path.join(__dirname, "fixtures", "identityPersistenceReader.ts");

const TEST_TIMEOUT_MS = 30_000;

type CollectedProcess = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
};

function spawnFixture(script: string, env: NodeJS.ProcessEnv): CollectedProcess {
  // Run tsx as a loader on a plain `node` invocation (`node --import tsx
  // script.ts`) rather than through the `tsx` CLI binary. The CLI is a thin
  // wrapper that can put a shell/exec layer between this test and the
  // actual script process, which makes signal delivery (this test sends
  // real SIGTERM to prove the real shutdown-save path) depend on how that
  // wrapper forwards signals. Importing tsx as a loader keeps this a single
  // real `node` process end to end, so `child.kill("SIGTERM")` targets the
  // exact process running the fixture, deterministically.
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: monadRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collected: CollectedProcess = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    collected.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    collected.stderr += chunk.toString("utf8");
  });
  return collected;
}

function waitForStdoutMarker(proc: CollectedProcess, marker: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (proc.stdout.includes(marker)) {
        resolve();
        return;
      }
      if (proc.child.exitCode !== null) {
        reject(
          new Error(
            `process exited (code=${proc.child.exitCode}) before printing "${marker}".\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
          ),
        );
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for "${marker}".\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForExit(proc: CollectedProcess, timeoutMs: number): Promise<number | null> {
  if (proc.child.exitCode !== null) return Promise.resolve(proc.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for process exit.\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`));
    }, timeoutMs);
    proc.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("Identity-Bound Secrets — real Monad process-lifecycle round trip", () => {
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
    "save (kill -SIGTERM) -> stop -> start -> unlock -> resupply recovers the exact original value",
    async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-identity-persist-"));

      const sharedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        SEED: "process-lifecycle-test-seed-do-not-use-in-prod",
        ME_SEED: undefined,
        ME_STATE_DIR: stateDir,
        TEST_IDENTITY_PASSWORD: "process-lifecycle-password-123",
        TEST_BRANCH_SECRET: "process-lifecycle-branch-secret",
        TEST_BRANCH_VALUE: "process-lifecycle-recovered-value",
      };

      // 1) Writer process: real identity root + protected write, through
      // Monad's real getKernel(). Wait for it to confirm the write, then
      // kill it with SIGTERM — the same signal a real deploy/restart sends
      // — and let Monad's real setupPersistence() shutdown hook save the
      // snapshot, rather than calling saveSnapshot() ourselves.
      const writer = spawnFixture(writerScript, sharedEnv);
      spawned.push(writer);
      await waitForStdoutMarker(writer, "WRITER_READY", TEST_TIMEOUT_MS);

      writer.child.kill("SIGTERM");
      const writerExitCode = await waitForExit(writer, TEST_TIMEOUT_MS);
      expect(writerExitCode, `writer stderr:\n${writer.stderr}`).toBe(0);
      expect(writer.stdout).toContain("[kernel] snapshot saved to");

      const snapshotPath = path.join(stateDir, "snapshot.json");
      expect(fs.existsSync(snapshotPath), "writer must have persisted snapshot.json via saveSnapshot()").toBe(true);

      const onDiskSnapshot = fs.readFileSync(snapshotPath, "utf8");
      expect(onDiskSnapshot).not.toContain("process-lifecycle-branch-secret");
      expect(onDiskSnapshot).not.toContain("process-lifecycle-recovered-value");
      expect(onDiskSnapshot).not.toContain("process-lifecycle-password-123");

      // 2) Reader process: a genuinely fresh process (own empty kernel
      // singleton) pointed at the SAME ME_STATE_DIR, exercising Monad's
      // real getKernel()-hydrates-from-snapshot.json startup path exactly
      // like a restarted monad.ai would.
      const reader = spawnFixture(readerScript, sharedEnv);
      spawned.push(reader);
      const readerExitCode = await waitForExit(reader, TEST_TIMEOUT_MS);

      expect(reader.stdout, `reader stderr:\n${reader.stderr}`).toContain(
        "READER_BEFORE_UNLOCK <undefined>",
      );
      expect(reader.stdout).toContain("READER_AFTER_UNLOCK_NO_SECRET <undefined>");
      expect(reader.stdout).toContain(`READER_RECOVERED ${JSON.stringify("process-lifecycle-recovered-value")}`);
      expect(reader.stdout).toContain("READER_PASS");
      expect(readerExitCode, `reader stderr:\n${reader.stderr}`).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the wrong password fails closed instead of recovering the branch value",
    async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-identity-persist-wrongpw-"));

      const writeEnv: NodeJS.ProcessEnv = {
        ...process.env,
        SEED: "process-lifecycle-test-seed-do-not-use-in-prod",
        ME_SEED: undefined,
        ME_STATE_DIR: stateDir,
        TEST_IDENTITY_PASSWORD: "the-real-password-1",
        TEST_BRANCH_SECRET: "wrongpw-branch-secret",
        TEST_BRANCH_VALUE: "wrongpw-recovered-value",
      };

      const writer = spawnFixture(writerScript, writeEnv);
      spawned.push(writer);
      await waitForStdoutMarker(writer, "WRITER_READY", TEST_TIMEOUT_MS);
      writer.child.kill("SIGTERM");
      await waitForExit(writer, TEST_TIMEOUT_MS);

      const readEnv: NodeJS.ProcessEnv = { ...writeEnv, TEST_IDENTITY_PASSWORD: "a-completely-wrong-password" };
      const reader = spawnFixture(readerScript, readEnv);
      spawned.push(reader);
      const readerExitCode = await waitForExit(reader, TEST_TIMEOUT_MS);

      // unlockIdentity() must reject a wrong password rather than silently
      // "succeeding" with garbage key material.
      expect(reader.stderr).toContain("READER_ERROR");
      expect(readerExitCode).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
