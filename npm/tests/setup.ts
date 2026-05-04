import fs from "fs";
import os from "os";
import path from "path";

process.env.SEED = "test-seed-jest-canonical-replay-do-not-use-in-prod";
process.env.ME_NAMESPACE = "cleaker.me";

const meStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-me-state-"));
const claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claims-state-"));

process.env.ME_STATE_DIR = meStateDir;
process.env.MONAD_CLAIM_DIR = claimDir;

process.on("exit", () => {
  fs.rmSync(meStateDir, { recursive: true, force: true });
  fs.rmSync(claimDir, { recursive: true, force: true });
});
