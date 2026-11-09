/**
 * The monad's state is readable only by the user it runs as (www-data and other local users must not read it).
 * Pinned: a fresh state dir is 0700 and snapshot.json 0600 from the first save (the temp file is CREATED private, not made
 * private after); repeated saves keep it so and leave no temp behind; a restart over state an older writer left broad
 * (dir 0755, snapshot 0644) narrows it; and an older writer that later creates 0644 files inside cannot reopen the
 * exposure, because the directory stays 0700 (what a rollback to a previous release relies on).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKernel, getKernelStateDir, resetKernelStateForTests, saveSnapshotOrThrow } from "../src/kernel/manager";
import { ensurePrivateDir } from "../src/kernel/privateFs";

const mode = (p: string) => fs.statSync(p).mode & 0o777;
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = { ME_STATE_DIR: process.env.ME_STATE_DIR, SEED: process.env.SEED };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-state-privacy-"));
  process.env.SEED = "test-seed-state-privacy";
  process.env.ME_STATE_DIR = path.join(root, "state");
});
afterEach(() => {
  resetKernelStateForTests();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the monad's state is private to its user", () => {
  it("a new state dir is 0700 and every save writes snapshot.json 0600, with no temp left", () => {
    getKernel();
    expect(mode(getKernelStateDir())).toBe(0o700);
    for (let i = 0; i < 3; i++) saveSnapshotOrThrow();
    expect(mode(path.join(getKernelStateDir(), "snapshot.json"))).toBe(0o600);
    expect(fs.readdirSync(getKernelStateDir()).filter((f) => f.startsWith(".snapshot.json.tmp-"))).toEqual([]);
  });

  it("a restart over state an older writer left broad (0755 / 0644) narrows it", () => {
    getKernel(); saveSnapshotOrThrow();
    const old = path.join(root, "old-state");
    fs.cpSync(getKernelStateDir(), old, { recursive: true });
    fs.rmSync(path.join(old, "process.lock"), { recursive: true, force: true });
    fs.chmodSync(old, 0o755); fs.chmodSync(path.join(old, "snapshot.json"), 0o644);
    resetKernelStateForTests();
    process.env.ME_STATE_DIR = old;
    getKernel();
    expect(mode(old)).toBe(0o700);
    expect(mode(path.join(old, "snapshot.json"))).toBe(0o600);
  });

  it("after a rollback an older writer's 0644 files stay unreachable: the dir keeps 0700", () => {
    getKernel(); saveSnapshotOrThrow();
    const dir = getKernelStateDir();
    fs.mkdirSync(dir, { recursive: true });                                   // what an older writer does (no mode)
    fs.writeFileSync(path.join(dir, "snapshot.json"), "{}", "utf8");          // ...and how it writes (default 0644)
    expect(mode(dir)).toBe(0o700);
  });

  it("a state dir that cannot be made private stops the start (it does not continue with a warning)", () => {
    // a directory this user does not own: chmod is refused, and the kernel must not come up on it
    expect(() => ensurePrivateDir("/usr")).toThrow();
    resetKernelStateForTests();
    process.env.ME_STATE_DIR = "/usr";
    expect(() => getKernel()).toThrow();
    process.env.ME_STATE_DIR = path.join(root, "state");
  });

  it("ensurePrivateDir narrows an existing directory (mkdir's mode alone would not)", () => {
    const d = path.join(root, "claims"); fs.mkdirSync(d, { mode: 0o755 }); fs.chmodSync(d, 0o755);
    ensurePrivateDir(d);
    expect(mode(d)).toBe(0o700);
  });
});
