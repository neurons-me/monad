import { parseBridgeTarget } from "../../src/runtime/bridge.js";

describe("parseBridgeTarget — cleaker v3 (__ptr.target) API", () => {
  it("parses standard namespace:op/path", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile");
    expect(r).not.toBeNull();
    expect(r!.namespace).toBe("suis-macbook-air.local");
    expect(r!.selector).toBe("read");
    expect(r!.pathSlash).toBe("profile");
    expect(r!.pathDot).toBe("profile");
  });

  it("parses dot-prefixed path (.mesh/monads)", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/.mesh/monads");
    expect(r).not.toBeNull();
    expect(r!.pathSlash).toBe(".mesh/monads");
    expect(r!.pathDot).toBe(".mesh.monads");
  });

  it("parses __surface path", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/__surface");
    expect(r).not.toBeNull();
    expect(r!.pathSlash).toBe("__surface");
    expect(r!.pathDot).toBe("__surface");
  });

  it("parses nested path into dot notation", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile/name");
    expect(r!.pathSlash).toBe("profile/name");
    expect(r!.pathDot).toBe("profile.name");
  });

  it("returns null for empty input", () => {
    expect(parseBridgeTarget("")).toBeNull();
    expect(parseBridgeTarget("   ")).toBeNull();
  });

  it("normalizes namespace to lowercase", () => {
    const r = parseBridgeTarget("me://SUIS-MACBOOK-AIR.LOCAL:read/profile");
    expect(r?.namespace).toBe("suis-macbook-air.local");
  });

  it("accepts shorthand without me:// prefix", () => {
    const r = parseBridgeTarget("suis-macbook-air.local:read/profile");
    expect(r).not.toBeNull();
    expect(r!.namespace).toBe("suis-macbook-air.local");
  });

  it("builds correct nrp", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/profile");
    expect(r!.nrp).toBe("me://suis-macbook-air.local:read/profile");
  });

  it("nrp uses underscore for empty path", () => {
    const r = parseBridgeTarget("me://suis-macbook-air.local:read/");
    if (r) expect(r.nrp).toMatch(/_$/);
  });
});
