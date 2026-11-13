import { saveSnapshot } from "./manager.js";

let _registered = false;

/**
 * Synchronous steps run right before the shutdown save (SIGTERM, SIGINT, beforeExit), so state they write is in the
 * snapshot that save produces -- e.g. the usage ledger closing its open window. Each step is isolated: one that throws
 * is logged and skipped; the save still happens.
 */
const beforeShutdownSave: Array<() => void> = [];

export function addBeforeShutdownSave(step: () => void): void {
  if (!beforeShutdownSave.includes(step)) beforeShutdownSave.push(step);
}

function runBeforeShutdownSave(): void {
  for (const step of beforeShutdownSave) {
    try {
      step();
    } catch (error) {
      console.error("[kernel] step before shutdown save failed:", error);
    }
  }
}

export function setupPersistence(): void {
  if (_registered) return;
  _registered = true;

  const shutdown = (signal: string) => {
    console.log(`[kernel] ${signal} — saving snapshot before exit`);
    runBeforeShutdownSave();
    saveSnapshot();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("beforeExit", () => {
    runBeforeShutdownSave();
    saveSnapshot();
  });
}
