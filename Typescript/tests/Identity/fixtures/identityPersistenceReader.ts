/**
 * identityPersistenceReader.ts — child-process fixture for
 * identityRootPersistence.process.test.ts.
 *
 * A genuinely separate, fresh Node process (own empty `_kernel` module
 * singleton — see src/kernel/manager.ts) pointed at the SAME ME_STATE_DIR
 * the writer fixture just saved into. Calls Monad's real `getKernel()`,
 * which hydrates from `snapshot.json` on disk exactly the way a restarted
 * monad.ai process does, then unlocks the identity root and resupplies the
 * branch secret through the kernel object directly (Monad has no HTTP route
 * for this yet — out of scope per the task; this still exercises Monad's
 * real process and real persistence code, which is the actual requirement).
 */
import { getKernel } from "../../../src/kernel/manager.js";

function fmt(value: unknown): string {
  return value === undefined ? "<undefined>" : JSON.stringify(value);
}

async function main(): Promise<void> {
  const password = process.env.TEST_IDENTITY_PASSWORD;
  const branchSecret = process.env.TEST_BRANCH_SECRET;
  const expectedValue = process.env.TEST_BRANCH_VALUE;
  if (!password || !branchSecret || !expectedValue) {
    console.error("READER_ERROR missing TEST_IDENTITY_PASSWORD/TEST_BRANCH_SECRET/TEST_BRANCH_VALUE");
    process.exit(1);
  }

  // Real Monad kernel singleton — hydrates from the writer's persisted
  // snapshot.json exactly like a restarted monad.ai process would
  // (getKernel() checks existsSync(snapshotPath) and calls hydrate()).
  const kernel = getKernel();

  const beforeUnlock = (kernel as any)("vault.balance");
  console.log(`READER_BEFORE_UNLOCK ${fmt(beforeUnlock)}`);

  await kernel.unlockIdentity(password);

  const afterUnlockNoSecret = (kernel as any)("vault.balance");
  console.log(`READER_AFTER_UNLOCK_NO_SECRET ${fmt(afterUnlockNoSecret)}`);

  // Option B — no silent recovery: resupply the branch secret explicitly.
  (kernel as any).vault["_"](branchSecret);
  const recovered = (kernel as any)("vault.balance");
  console.log(`READER_RECOVERED ${fmt(recovered)}`);

  if (recovered === expectedValue) {
    console.log("READER_PASS");
    process.exit(0);
  } else {
    console.error(`READER_FAIL expected=${fmt(expectedValue)} actual=${fmt(recovered)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("READER_ERROR", err);
  process.exit(1);
});
