/**
 * identityPersistenceWriter.ts — child-process fixture for
 * identityRootPersistence.process.test.ts.
 *
 * Runs as a genuinely separate Node process (spawned by the parent test via
 * `tsx`, not imported in-process). It exercises Monad's REAL kernel
 * singleton and persistence code (`getKernel()`, `saveSnapshot()`,
 * `setupPersistence()` from `src/kernel/manager.ts`/`src/kernel/persist.ts`)
 * — not a reproduction of `.me`'s logic, the actual module Monad itself
 * imports at `import ME from "this.me"` (see manager.ts's own import).
 *
 * Protocol with the parent test:
 *  1. Reads TEST_IDENTITY_PASSWORD / TEST_BRANCH_SECRET / TEST_BRANCH_VALUE
 *     from the environment (parent-controlled, not hardcoded here).
 *  2. Creates an identity root, declares a branch secret, writes a
 *     protected value under it.
 *  3. Prints "WRITER_READY" once the write is confirmed readable in this
 *     live session, then stays alive.
 *  4. Registers Monad's real `setupPersistence()` shutdown hook, so a
 *     SIGTERM from the parent triggers the actual production
 *     graceful-shutdown save path (`saveSnapshot()` then `process.exit`),
 *     not a manual save call standing in for it.
 */
import { getKernel } from "../../../src/kernel/manager.js";
import { setupPersistence } from "../../../src/kernel/persist.js";

async function main(): Promise<void> {
  const password = process.env.TEST_IDENTITY_PASSWORD;
  const branchSecret = process.env.TEST_BRANCH_SECRET;
  const branchValue = process.env.TEST_BRANCH_VALUE;
  if (!password || !branchSecret || !branchValue) {
    console.error("WRITER_ERROR missing TEST_IDENTITY_PASSWORD/TEST_BRANCH_SECRET/TEST_BRANCH_VALUE");
    process.exit(1);
  }

  // Real Monad kernel singleton — same getKernel() Monad's HTTP handlers call.
  const kernel = getKernel();
  // Real Monad graceful-shutdown hook — same one server.ts's process wires up.
  setupPersistence();

  await kernel.createIdentityRoot(password);
  (kernel as any).vault["_"](branchSecret);
  (kernel as any).vault.balance(branchValue);

  const liveRead = (kernel as any)("vault.balance");
  if (liveRead !== branchValue) {
    console.error(`WRITER_SANITY_FAILED expected=${branchValue} actual=${String(liveRead)}`);
    process.exit(1);
  }

  console.log("WRITER_READY");
  // Stay alive until the parent sends SIGTERM — that's what actually
  // exercises setupPersistence()'s real shutdown-save path, instead of this
  // script calling saveSnapshot() itself.
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error("WRITER_ERROR", err);
  process.exit(1);
});
