import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "tests/Security/fixtures/stateDirLockContender.ts");
const children: ChildProcess[] = [];
const dirs: string[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-lock-race-"));
  dirs.push(dir);
  return dir;
}
function start(dir: string, name: string, pause?: string) {
  const signal = path.join(dir, name);
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: root,
    env: { ...process.env, SEED: "disposable-lock-race", ME_STATE_DIR: path.join(dir, "state"),
      LOCK_TEST_SIGNAL: signal, LOCK_TEST_PAUSE: pause },
    stdio: "ignore",
  });
  children.push(child);
  return { child, signal };
}
async function waitFile(file: string) {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await sleep(10);
  }
  return fs.readFileSync(file, "utf8");
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => kill(child)));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("exactly one kernel survives when a publisher pauses before its ownership is visible", async () => {
  const dir = temp();
  const first = start(dir, "first", "publish");
  await waitFile(`${first.signal}.paused`);
  const second = start(dir, "second");
  expect(await waitFile(`${second.signal}.result`)).toBe("acquired");
  fs.writeFileSync(`${first.signal}.resume`, "");
  const firstResult = await waitFile(`${first.signal}.result`);
  expect(firstResult).toContain("STATE_DIR_ALREADY_IN_USE");
  expect(second.child.exitCode).toBeNull();
  expect(second.child.signalCode).toBeNull();
}, 30_000);

it("a delayed stale-lock reaper cannot remove a live successor's lock", async () => {
  const dir = temp();
  const original = start(dir, "original");
  expect(await waitFile(`${original.signal}.result`)).toBe("acquired");
  await kill(original.child); // real stale lock, no exit cleanup
  const delayed = start(dir, "delayed", "reap");
  await waitFile(`${delayed.signal}.paused`);
  const successor = start(dir, "successor");
  expect(await waitFile(`${successor.signal}.result`)).toBe("acquired");
  fs.writeFileSync(`${delayed.signal}.resume`, "");
  expect(await waitFile(`${delayed.signal}.result`)).toContain("STATE_DIR_ALREADY_IN_USE");
  // Refusal/cleanup must not unlock the survivor for a third contender.
  const third = start(dir, "third");
  expect(await waitFile(`${third.signal}.result`)).toContain("STATE_DIR_ALREADY_IN_USE");
  expect(successor.child.exitCode).toBeNull();
  expect(successor.child.signalCode).toBeNull();
}, 30_000);

it("fails closed for an incomplete legacy lock and respects a live legacy owner", async () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "state"));
  const lock = path.join(dir, "state/process.lock");
  fs.writeFileSync(lock, "");
  const incomplete = start(dir, "incomplete");
  expect(await waitFile(`${incomplete.signal}.result`)).toContain("STATE_DIR_ALREADY_IN_USE");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const live = start(dir, "live");
  expect(await waitFile(`${live.signal}.result`)).toContain("STATE_DIR_ALREADY_IN_USE");
}, 30_000);

it("recovers a dead legacy JSON lock and releases its replacement on clean exit", async () => {
  const dir = temp();
  const old = start(dir, "old");
  expect(await waitFile(`${old.signal}.result`)).toBe("acquired");
  await kill(old.child);
  const lock = path.join(dir, "state/process.lock");
  fs.rmSync(lock, { recursive: true, force: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: old.child.pid }));
  const replacement = start(dir, "replacement");
  expect(await waitFile(`${replacement.signal}.result`)).toBe("acquired");
  await kill(replacement.child, "SIGTERM");
  expect(fs.existsSync(lock)).toBe(false);
}, 30_000);
