import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMonadSeed } from "../src/cli/runtime.js";
import {
  describeMonadEnv,
  monadEnvPath,
  readMonadEnv,
  validateMonadEnvKey,
  writeMonadEnv,
} from "../src/cli/monadEnv.js";

let home: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.MONADS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "monad-env-"));
  process.env.MONADS_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.MONADS_HOME;
  else process.env.MONADS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a monad's own environment (env.json)", () => {
  it("is empty until something is stored, and a broken file reads as empty", () => {
    expect(readMonadEnv("cleaker")).toEqual({});
    fs.mkdirSync(path.dirname(monadEnvPath("cleaker")), { recursive: true });
    fs.writeFileSync(monadEnvPath("cleaker"), "{not json");
    expect(readMonadEnv("cleaker")).toEqual({});
  });

  it("stores variables, keeps the file private (0600), merges, and removes with null", () => {
    writeMonadEnv("cleaker", { SEED: "a".repeat(64), MONAD_MODULES: "netget/gateway" });
    expect(readMonadEnv("cleaker")).toEqual({ SEED: "a".repeat(64), MONAD_MODULES: "netget/gateway" });
    expect(fs.statSync(monadEnvPath("cleaker")).mode & 0o777).toBe(0o600);

    writeMonadEnv("cleaker", { MONAD_MODULES: null, NETGET_MONAD_NAME: "local" });
    expect(readMonadEnv("cleaker")).toEqual({ SEED: "a".repeat(64), NETGET_MONAD_NAME: "local" });
    expect(fs.statSync(monadEnvPath("cleaker")).mode & 0o777).toBe(0o600);
  });

  it("is per monad", () => {
    writeMonadEnv("local", { SEED: "one" });
    writeMonadEnv("cleaker", { SEED: "two" });
    expect(readMonadEnv("local").SEED).toBe("one");
    expect(readMonadEnv("cleaker").SEED).toBe("two");
  });

  it("refuses names that are not UPPER_CASE, and the ones the process manager decides", () => {
    expect(() => validateMonadEnvKey("seed")).toThrow(/Invalid variable name/);
    expect(() => validateMonadEnvKey("PATH; rm")).toThrow(/Invalid variable name/);
    for (const managed of ["PORT", "ME_NAMESPACE", "ME_STATE_DIR", "MONAD_NAME", "MONAD_SELF_ENDPOINT"]) {
      expect(() => writeMonadEnv("cleaker", { [managed]: "x" })).toThrow(/process manager/);
    }
    expect(readMonadEnv("cleaker")).toEqual({});
  });

  it("never returns a managed key even if the file was edited by hand", () => {
    fs.mkdirSync(path.dirname(monadEnvPath("cleaker")), { recursive: true });
    fs.writeFileSync(monadEnvPath("cleaker"), JSON.stringify({ PORT: "1", ME_NAMESPACE: "evil.me", SEED: "ok", lower: "x", N: 3 }));
    expect(readMonadEnv("cleaker")).toEqual({ SEED: "ok" });
  });

  it("hides secret values when describing", () => {
    const rows = describeMonadEnv({ SEED: "s3cret-value", MONAD_MODULES: "netget/gateway", ADMIN_TOKEN: "abc" });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toContain("abc");
    expect(rows.find((r) => r.key === "MONAD_MODULES")?.value).toBe("netget/gateway");
    expect(rows.find((r) => r.key === "SEED")?.value).toMatch(/set/);
  });
});

describe("which seed a monad starts with", () => {
  it("prefers explicit, then the monad's own, then the shell's, and the name only last", () => {
    const all = { explicit: "E", stored: "S", shell: "H", namespace: "cleaker.me" };
    expect(resolveMonadSeed(all)).toBe("E");
    expect(resolveMonadSeed({ ...all, explicit: undefined })).toBe("S");
    expect(resolveMonadSeed({ ...all, explicit: undefined, stored: undefined })).toBe("H");
    expect(resolveMonadSeed({ namespace: "cleaker.me" })).toBe("cleaker.me");
  });

  it("a restart from a clean shell keeps the stored seed instead of falling back to the name", () => {
    writeMonadEnv("cleaker", { SEED: "b".repeat(64) });
    const stored = readMonadEnv("cleaker");
    expect(resolveMonadSeed({ stored: stored.SEED, namespace: "cleaker.me" })).toBe("b".repeat(64));
  });
});
