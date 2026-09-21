import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Pause real filesystem operations at the two historical race windows. No
// production test hooks or scheduling assumptions: the parent releases a file
// barrier only after the competing process has acquired its actual kernel.
const signal = process.env.LOCK_TEST_SIGNAL!;
const lockPath = path.join(process.env.ME_STATE_DIR!, "process.lock");
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  fs.writeFileSync(`${signal}.paused`, "");
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(`${signal}.resume`)) {
    if (Date.now() > deadline) throw new Error("lock test barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (process.env.LOCK_TEST_PAUSE === "publish") {
  const open = fs.openSync;
  fs.openSync = ((file: any, flags: any, ...args: any[]) => {
    const fd = (open as any)(file, flags, ...args);
    if (String(file) === lockPath && flags === "wx") pause(); // legacy window
    return fd;
  }) as typeof fs.openSync;
  const rename = fs.renameSync;
  fs.renameSync = ((from: any, to: any) => {
    if (String(to) === lockPath) pause(); // fully prepared candidate
    return rename(from, to);
  }) as typeof fs.renameSync;
}
if (process.env.LOCK_TEST_PAUSE === "reap") {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = ((file: any) => {
    if (String(file) === lockPath || path.dirname(String(file)) === lockPath) pause();
    return unlink(file);
  }) as typeof fs.unlinkSync;
}
syncBuiltinESMExports();

try {
  const { getKernel } = await import("../../../src/kernel/manager.js");
  getKernel();
  fs.writeFileSync(`${signal}.result`, "acquired");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} catch (error) {
  fs.writeFileSync(`${signal}.result`, String(error));
  process.exit(1);
}
