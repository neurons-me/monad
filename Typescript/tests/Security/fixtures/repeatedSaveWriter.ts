/**
 * repeatedSaveWriter.ts — child-process fixture for
 * processInterruption.process.test.ts.
 *
 * Runs Monad's REAL getKernel()/saveSnapshot() (src/kernel/manager.ts) in a
 * tight loop — write a protected value, call saveSnapshot() directly (not
 * only on a shutdown signal) — printing a progress marker after each
 * completed save. The parent test SIGKILLs this process at an
 * unpredictable point in the loop (unlike identityPersistenceWriter.ts,
 * which is killed with SIGTERM after a single confirmed write). The point
 * is to maximize the chance a kill lands mid-saveSnapshot(), to exercise
 * the atomic write fix (temp file + rename) against a REAL abrupt
 * termination, not just reasoning about it.
 */
import { getKernel, saveSnapshot } from "../../../src/kernel/manager.js";

async function main(): Promise<void> {
  const password = process.env.TEST_IDENTITY_PASSWORD;
  const branchSecret = process.env.TEST_BRANCH_SECRET;
  const iterations = Number(process.env.TEST_ITERATIONS || "200");
  if (!password || !branchSecret) {
    console.error("WRITER_ERROR missing TEST_IDENTITY_PASSWORD/TEST_BRANCH_SECRET");
    process.exit(1);
  }

  const kernel = getKernel() as any;
  await kernel.createIdentityRoot(password);
  kernel.vault["_"](branchSecret);

  for (let i = 0; i < iterations; i++) {
    kernel.vault.counter(i);
    saveSnapshot();
    console.log(`SAVE_DONE ${i}`);
  }
  console.log("WRITER_ALL_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error("WRITER_ERROR", err);
  process.exit(1);
});
