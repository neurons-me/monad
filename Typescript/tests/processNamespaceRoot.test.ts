import { describe, expect, it } from "vitest";
import { declaredLoopbackRoot, resolveStatedRoot } from "../src/cli/runtime";

// What a monad is started with and what its record says must be the same root. `localhost` stated as the
// namespace is the declared one-label root, not an alias to be folded into the machine's own hostname.
describe("the root a monad is started or recorded under", () => {
  it("keeps a stated `localhost` as written, in any case and with a port", () => {
    expect(declaredLoopbackRoot("localhost")).toBe("localhost");
    expect(declaredLoopbackRoot(" LocalHost ")).toBe("localhost");
    expect(declaredLoopbackRoot("localhost:8161")).toBe("localhost");
    expect(resolveStatedRoot("localhost")).toBe("localhost");
  });

  it("does not turn the other loopback spellings or non-roots into declared roots", () => {
    for (const value of ["127.0.0.1", "0.0.0.0", "", null, undefined, "jabellae.localhost", "suis-macbook-air.local"]) {
      expect(declaredLoopbackRoot(value as unknown)).toBeNull();
    }
  });

  it("leaves every other namespace exactly as the normalizer had it", () => {
    expect(resolveStatedRoot("cleaker.me")).toBe("cleaker.me");
    expect(resolveStatedRoot("Netget.Site:443")).toBe("netget.site");
    expect(resolveStatedRoot("ana.cleaker.me")).toBe("cleaker.me");
  });

  it("still folds an unconfigured 127.0.0.1 into this machine's own root, as before", () => {
    expect(resolveStatedRoot("127.0.0.1")).not.toBe("127.0.0.1");
  });
});
