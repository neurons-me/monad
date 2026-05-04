import ME from "this.me";
import os from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { normalizeNamespaceRootName } from "../namespace/identity.js";

const DEFAULT_ME_STATE_DIR = resolve(process.cwd(), "me-state");

let _kernel: InstanceType<typeof ME> | null = null;

export function getKernelStateDir(): string {
  const configured = String(process.env.ME_STATE_DIR || "").trim();
  return configured ? resolve(configured) : DEFAULT_ME_STATE_DIR;
}

export function getKernelStatePath(...segments: string[]): string {
  return resolve(getKernelStateDir(), ...segments);
}

export function getKernel(): InstanceType<typeof ME> {
  if (_kernel) return _kernel;

  const seed = process.env.SEED || process.env.ME_SEED;
  if (!seed) throw new Error("SEED is required — set it in your environment before starting monad.ai");

  mkdirSync(getKernelStateDir(), { recursive: true });

  _kernel = new ME(seed, {
    store: new ME.DiskStore({ baseDir: getKernelStateDir() }),
  });

  const snapshotPath = getKernelStatePath("snapshot.json");
  if (existsSync(snapshotPath)) {
    try {
      const raw = readFileSync(snapshotPath, "utf8");
      _kernel.hydrate(JSON.parse(raw));
      console.log("[kernel] hydrated from snapshot");
    } catch (e) {
      console.warn("[kernel] snapshot hydration failed, starting fresh:", e);
    }
  }

  return _kernel;
}

export function saveSnapshot(): void {
  if (!_kernel) return;
  try {
    const snapshotPath = getKernelStatePath("snapshot.json");
    mkdirSync(getKernelStateDir(), { recursive: true });
    const snapshot = _kernel.exportSnapshot();
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
    console.log("[kernel] snapshot saved to", snapshotPath);
  } catch (e) {
    console.error("[kernel] snapshot save failed:", e);
  }
}

export function kernelReady(): boolean {
  return _kernel !== null;
}

export function getRootNamespace(): string {
  const explicit = String(
    process.env.ME_NAMESPACE ||
      process.env.MONAD_SELF_IDENTITY ||
      process.env.MONAD_SELF_HOSTNAME ||
      os.hostname() ||
      "",
  ).trim();
  return normalizeNamespaceRootName(explicit) || "unknown";
}

export function namespaceToKernelPrefix(namespace: string): string {
  const ns = namespace.trim().toLowerCase();
  const root = getRootNamespace();
  if (ns === root) return "";
  if (ns.endsWith(`.${root}`)) {
    const username = ns.slice(0, -(root.length + 1)).split(".")[0] ?? ns;
    return `users.${username}`;
  }
  // Unknown domain — not a managed namespace, do not assume identity
  return "";
}

export function kernelPathFor(namespace: string, path: string): string {
  const prefix = namespaceToKernelPrefix(namespace);
  return prefix ? `${prefix}.${path}` : path;
}

export function resetKernelStateForTests(): void {
  _kernel = null;
  rmSync(getKernelStateDir(), { recursive: true, force: true });
}
