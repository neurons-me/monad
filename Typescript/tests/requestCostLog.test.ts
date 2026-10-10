/**
 * requestCostLog.test.ts — the request path must not copy the kernel's whole memory log.
 *
 * `kernel.memories` builds one new object per memory on every call. On a log of
 * hundreds of thousands of entries that cost ~0.8 s per call, once per HTTP request
 * (and again per usage-ledger write). memoryStore now reads the log through
 * `getKernelMemoryLog()` and `listSemanticMemoriesByRootNamespace` stops at `limit`.
 *
 * WHAT WE PROVE:
 *   1. the no-copy view is the same log (length, order, fields) as the public getter;
 *   2. the read-only consumers do not change the log;
 *   3. listSemanticMemoriesByRootNamespace returns exactly what the original
 *      map-everything-then-slice algorithm returned, for several limits and with/without
 *      system paths;
 *   4. the hot path never touches the copying getter.
 */
import assert from "assert";
import crypto from "crypto";
import { getKernel, getKernelMemoryLog, getRootNamespace } from "../src/kernel/manager";
import {
  appendSemanticMemory,
  isSystemSemanticPath,
  listSemanticMemoriesByNamespace,
  listSemanticMemoriesByRootNamespace,
} from "../src/claim/memoryStore";
import { normalizeNamespaceRootName } from "../src/namespace/identity";

function uid() {
  return `rc${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

function seed(): { users: string[] } {
  const root = getRootNamespace();
  const users = [uid(), uid()];
  let t = Date.now();
  for (let i = 0; i < 12; i++) {
    appendSemanticMemory({ namespace: root, path: `rootdata.k${i}`, operator: "=", data: i, timestamp: t++ });
    for (const u of users) {
      appendSemanticMemory({ namespace: `${u}.${root}`, path: `profile.f${i}`, operator: "=", data: `${u}-${i}`, timestamp: t++ });
    }
  }
  appendSemanticMemory({ namespace: users[0] + "." + root, path: "profile.f3", operator: "-", data: null, timestamp: t++ });
  return { users };
}

// The ORIGINAL algorithm, reimplemented from the public log: build every row, then filter, then slice.
function reference(rootNamespaceInput: string, limitIn: number, includeSystem: boolean) {
  const rootNamespace = normalizeNamespaceRootName(rootNamespaceInput);
  const limit = Math.max(1, Math.min(5_000, limitIn));
  const root = getRootNamespace();
  return (getKernel().memories as any[])
    .map((m, i) => {
      let namespace = root;
      let path: string = m.path;
      if (path.startsWith("users.")) {
        const rest = path.slice("users.".length);
        const dot = rest.indexOf(".");
        if (dot !== -1) {
          namespace = `${rest.slice(0, dot)}.${root}`;
          path = rest.slice(dot + 1);
        }
      }
      return { id: i, namespace, path, operator: m.operator ?? null, data: m.value, hash: m.hash, timestamp: m.timestamp };
    })
    .filter((r) => normalizeNamespaceRootName(r.namespace) === rootNamespace)
    .filter((r) => includeSystem || !isSystemSemanticPath(r.path))
    .slice(0, limit);
}

test("the no-copy log view is the same log as the public getter", () => {
  seed();
  const view = getKernelMemoryLog();
  const pub = getKernel().memories as any[];
  assert.equal(view.length, pub.length);
  for (let i = 0; i < pub.length; i++) {
    const a = view[i]!, b = pub[i];
    assert.equal(a.path, b.path);
    assert.equal(a.operator, b.operator);
    assert.equal(a.hash, b.hash);
    assert.equal(a.prevHash, b.prevHash);
    assert.equal(a.timestamp, b.timestamp);
    assert.deepEqual(a.value, b.value);
  }
});

test("read paths do not change the kernel log", () => {
  const { users } = seed();
  const digest = () =>
    crypto.createHash("sha256").update(JSON.stringify(getKernelMemoryLog().map((m) => [m.path, m.operator, m.hash, m.prevHash, m.timestamp, m.value]))).digest("hex");
  const before = digest();
  const len = getKernelMemoryLog().length;
  listSemanticMemoriesByRootNamespace(getRootNamespace(), { limit: 5000, includeSystem: true });
  listSemanticMemoriesByNamespace(`${users[0]}.${getRootNamespace()}`, { limit: 100 });
  assert.equal(getKernelMemoryLog().length, len);
  assert.equal(digest(), before);
});

test("listSemanticMemoriesByRootNamespace matches the original algorithm", () => {
  seed();
  const root = getRootNamespace();
  for (const limit of [1, 2, 7, 500, 5000]) {
    for (const includeSystem of [false, true]) {
      const got = listSemanticMemoriesByRootNamespace(root, { limit, includeSystem });
      const want = reference(root, limit, includeSystem);
      assert.equal(got.length, want.length, `length limit=${limit} sys=${includeSystem}`);
      for (let i = 0; i < want.length; i++) {
        assert.equal(got[i]!.id, want[i]!.id);
        assert.equal(got[i]!.namespace, want[i]!.namespace);
        assert.equal(got[i]!.path, want[i]!.path);
        assert.equal(got[i]!.operator, want[i]!.operator);
        assert.deepEqual(got[i]!.data, want[i]!.data);
        assert.equal(got[i]!.hash, want[i]!.hash);
        assert.equal(got[i]!.timestamp, want[i]!.timestamp);
      }
    }
  }
});

test("the request path never calls the copying `memories` getter", () => {
  const kernel = getKernel();
  const proto = Object.getPrototypeOf(kernel);
  const spy = vi.spyOn(proto, "memories", "get");
  try {
    const root = getRootNamespace();
    listSemanticMemoriesByRootNamespace(root, { limit: 50 });
    listSemanticMemoriesByNamespace(`${uid()}.${root}`, { limit: 50 });
    appendSemanticMemory({ namespace: root, path: `rootdata.${uid()}`, operator: "=", data: 1 });
    assert.equal(spy.mock.calls.length, 0);
  } finally {
    spy.mockRestore();
  }
});
