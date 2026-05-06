import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import {
  announceClaimedNamespaces,
  findMonadByName,
  findMonadsForNamespace,
  listMonadIndex,
  readMonadIndexEntry,
  writeMonadIndexEntry,
  type MonadIndexEntry,
} from "../../src/kernel/monadIndex.js";

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-idx-"));
  process.env.SEED = "nrp-index-test-seed";
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

function makeEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "test-m1",
    namespace: "suis-macbook-air.local",
    endpoint: "http://localhost:8161",
    name: "primary",
    claimed_namespaces: ["suis-macbook-air.local"],
    first_seen: Date.now() - 1000,
    last_seen: Date.now(),
    ...overrides,
  };
}

describe("write / read", () => {
  it("roundtrips an entry", () => {
    writeMonadIndexEntry(makeEntry());
    const r = readMonadIndexEntry("test-m1");
    expect(r).toBeDefined();
    expect(r!.namespace).toBe("suis-macbook-air.local");
    expect(r!.name).toBe("primary");
  });

  it("returns undefined for unknown id", () => {
    expect(readMonadIndexEntry("ghost")).toBeUndefined();
  });

  it("overwrites with the latest write", () => {
    writeMonadIndexEntry(makeEntry({ name: "v1" }));
    writeMonadIndexEntry(makeEntry({ name: "v2" }));
    expect(readMonadIndexEntry("test-m1")!.name).toBe("v2");
  });
});

describe("listMonadIndex ordering", () => {
  it("sorts by last_seen descending", () => {
    const now = Date.now();
    writeMonadIndexEntry(makeEntry({ monad_id: "a", last_seen: now - 3000 }));
    writeMonadIndexEntry(makeEntry({ monad_id: "b", last_seen: now - 1000 }));
    writeMonadIndexEntry(makeEntry({ monad_id: "c", last_seen: now }));
    const ids = listMonadIndex().map((e) => e.monad_id);
    expect(ids).toEqual(["c", "b", "a"]);
  });

  it("uses name as alphabetical tie-breaker when last_seen is equal", () => {
    const ts = Date.now();
    writeMonadIndexEntry(makeEntry({ monad_id: "z-m", name: "zach", last_seen: ts }));
    writeMonadIndexEntry(makeEntry({ monad_id: "a-m", name: "alice", last_seen: ts }));
    writeMonadIndexEntry(makeEntry({ monad_id: "m-m", name: "marco", last_seen: ts }));
    const names = listMonadIndex().map((e) => e.name);
    expect(names).toEqual(["alice", "marco", "zach"]);
  });
});

describe("findMonadsForNamespace", () => {
  it("matches by primary namespace", () => {
    writeMonadIndexEntry(makeEntry({ monad_id: "n1", namespace: "frank.local", claimed_namespaces: ["frank.local"] }));
    const found = findMonadsForNamespace("frank.local");
    expect(found).toHaveLength(1);
    expect(found[0]!.monad_id).toBe("n1");
  });

  it("matches by claimed_namespaces", () => {
    writeMonadIndexEntry(makeEntry({
      monad_id: "multi",
      namespace: "primary.local",
      claimed_namespaces: ["primary.local", "laptop.home", "alias.local"],
    }));
    expect(findMonadsForNamespace("laptop.home")).toHaveLength(1);
    expect(findMonadsForNamespace("alias.local")).toHaveLength(1);
    expect(findMonadsForNamespace("unknown.local")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    writeMonadIndexEntry(makeEntry({ namespace: "Frank.Local", claimed_namespaces: ["Frank.Local"] }));
    expect(findMonadsForNamespace("frank.local")).toHaveLength(1);
    expect(findMonadsForNamespace("FRANK.LOCAL")).toHaveLength(1);
  });

  it("returns empty for unknown namespace", () => {
    expect(findMonadsForNamespace("nobody.local")).toHaveLength(0);
  });
});

describe("findMonadByName", () => {
  it("finds by name (case-insensitive)", () => {
    writeMonadIndexEntry(makeEntry({ monad_id: "frank-m", name: "frank" }));
    expect(findMonadByName("frank")?.monad_id).toBe("frank-m");
    expect(findMonadByName("FRANK")?.monad_id).toBe("frank-m");
    expect(findMonadByName("Frank")?.monad_id).toBe("frank-m");
  });

  it("finds by monad_id exact match", () => {
    writeMonadIndexEntry(makeEntry({ monad_id: "exact-id-123" }));
    expect(findMonadByName("exact-id-123")?.monad_id).toBe("exact-id-123");
  });

  it("returns undefined when not found", () => {
    expect(findMonadByName("ghost")).toBeUndefined();
  });
});

describe("announceClaimedNamespaces", () => {
  it("merges new namespaces without duplicates", () => {
    writeMonadIndexEntry(makeEntry({ monad_id: "m1", claimed_namespaces: ["alpha.local"] }));
    announceClaimedNamespaces("m1", ["alpha.local", "beta.local"]);
    const r = readMonadIndexEntry("m1");
    expect(r!.claimed_namespaces).toContain("alpha.local");
    expect(r!.claimed_namespaces).toContain("beta.local");
    expect(r!.claimed_namespaces!.filter((n) => n === "alpha.local")).toHaveLength(1);
  });

  it("is a no-op for unknown monad_id", () => {
    expect(() => announceClaimedNamespaces("ghost", ["x.local"])).not.toThrow();
  });
});
