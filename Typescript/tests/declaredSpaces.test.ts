/**
 * declaredSpaces.test.ts — the spaces a monad declares are checked where they are configured.
 *
 * The host resolver reads three variables to know which spaces this runtime serves (ME_NAMESPACE,
 * MONAD_LOCAL_ALIAS_ROOT, MONAD_CANONICAL_SPACE). A bad one used to surface only as a failure on whichever
 * request happened to be resolved against it. Startup now checks the same list with the same rules (this.me
 * decides what a valid space is), names the variable, and writes nothing to process.env when it refuses.
 */
import fs from "node:fs";
import {
  REQUIRED_ME,
  IncompatibleMeError,
  assertDeclaredSpacesValid,
  assertMeCapabilities,
  readDeclaredSpaces,
  resolveHostToMeUri,
} from "../src/runtime/hostResolver.js";
import { resolveMonadRuntimeConfig } from "../src/bootstrap.js";

const DECLARING = ["ME_NAMESPACE", "MONAD_LOCAL_ALIAS_ROOT", "MONAD_CANONICAL_SPACE"] as const;

describe("declared spaces are validated at startup", () => {
  it("reads exactly the three variables the resolver uses, in order, ignoring empty ones", () => {
    expect(
      readDeclaredSpaces({ ME_NAMESPACE: "localhost", MONAD_LOCAL_ALIAS_ROOT: "  ", MONAD_CANONICAL_SPACE: "neurons.me" }),
    ).toEqual([
      { source: "ME_NAMESPACE", value: "localhost" },
      { source: "MONAD_CANONICAL_SPACE", value: "neurons.me" },
    ]);
  });

  it("accepts roots of one label, several labels, and mixed case", () => {
    expect(assertDeclaredSpacesValid({ ME_NAMESPACE: "localhost" })).toEqual(["localhost"]);
    expect(assertDeclaredSpacesValid({ ME_NAMESPACE: "here" })).toEqual(["here"]);
    expect(assertDeclaredSpacesValid({ ME_NAMESPACE: "local.cleaker" })).toEqual(["local.cleaker"]);
    // Case is folded by the this.me contract, so the monad does not reject what this.me accepts.
    expect(() => assertDeclaredSpacesValid({ ME_NAMESPACE: "LocalHost" })).not.toThrow();
  });

  it("accepts nothing declared: there is no list to be wrong", () => {
    expect(assertDeclaredSpacesValid({})).toEqual([]);
  });

  it.each(DECLARING)("refuses a bad %s and names the variable", (variable) => {
    const env = { ME_NAMESPACE: "localhost", [variable]: "bad_space!" };
    expect(() => assertDeclaredSpacesValid(env)).toThrow(new RegExp(`${variable}="bad_space!" is not a valid space`));
  });

  it("refuses a bad alias even when the main root is valid", () => {
    expect(() =>
      assertDeclaredSpacesValid({ ME_NAMESPACE: "localhost", MONAD_LOCAL_ALIAS_ROOT: "has space" }),
    ).toThrow(/MONAD_LOCAL_ALIAS_ROOT="has space" is not a valid space/);
  });
});

describe("a rejected start leaves the environment as it found it", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of [...DECLARING, "PORT", "MONAD_SELF_HOSTNAME", "MONAD_FETCH_TIMEOUT_MS"]) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not write PORT / ME_NAMESPACE when a declared space is invalid", () => {
    delete process.env.MONAD_CANONICAL_SPACE;
    process.env.MONAD_LOCAL_ALIAS_ROOT = "bad_alias!";
    const before = { ...process.env };
    expect(() => resolveMonadRuntimeConfig({ namespace: "localhost", port: 59999, hostname: "validate-test" })).toThrow(
      /MONAD_LOCAL_ALIAS_ROOT="bad_alias!" is not a valid space/,
    );
    expect(process.env.PORT).toBe(before.PORT);
    expect(process.env.ME_NAMESPACE).toBe(before.ME_NAMESPACE);
    expect(process.env.MONAD_SELF_HOSTNAME).toBe(before.MONAD_SELF_HOSTNAME);
  });

  it("starts with a valid single-label root and writes it", () => {
    delete process.env.MONAD_LOCAL_ALIAS_ROOT;
    delete process.env.MONAD_CANONICAL_SPACE;
    const config = resolveMonadRuntimeConfig({ namespace: "localhost", port: 59998, hostname: "validate-test" });
    expect(process.env.ME_NAMESPACE).toBe("localhost");
    expect(config).toBeTruthy();
  });
});

describe("the resolver and a single-label declared root", () => {
  it("resolves the root and a user inside it when the root is declared", () => {
    expect(resolveHostToMeUri("localhost", { knownSpaces: ["localhost"] })).toMatchObject({
      ok: true,
      kind: "space",
      space: "localhost",
    });
    expect(resolveHostToMeUri("jabellae.localhost", { knownSpaces: ["localhost"] })).toMatchObject({
      ok: true,
      kind: "namespace",
      namespace: "jabellae.localhost",
      handle: "jabellae",
      space: "localhost",
      canonical: "me://jabellae.localhost",
    });
  });

  it("reports a bad declaration as a failure result and never throws out of a request", () => {
    let result: ReturnType<typeof resolveHostToMeUri> | undefined;
    expect(() => {
      result = resolveHostToMeUri("jabellae.localhost", { knownSpaces: ["localhost", "bad_space!"] });
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, reason: "INVALID_KNOWN_SPACES" });
  });

  it("a received Host cannot make itself a root", () => {
    expect(resolveHostToMeUri("jabellae.evil.example", { knownSpaces: ["localhost"] })).toMatchObject({
      ok: false,
      reason: "UNKNOWN_SPACE",
    });
  });
});

describe("an incompatible this.me is its own failure, and is declared as a dependency", () => {
  it("accepts the installed this.me", () => {
    expect(() => assertMeCapabilities()).not.toThrow();
  });

  it("names the version and what is missing when a capability is absent", () => {
    const old = { validateKnownSpaces: () => [], parseMeSpaceUri: () => null };
    let caught: unknown;
    try {
      assertMeCapabilities(old);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IncompatibleMeError);
    const error = caught as IncompatibleMeError;
    expect(error.missing).toEqual(["tryParseMeSpaceUri"]);
    expect(error.message).toContain(`this.me >= ${REQUIRED_ME.version}`);
    expect(error.message).toContain("tryParseMeSpaceUri");
    expect(error.message).toMatch(/Update this\.me together with monad\.ai/);
  });

  it("is not mistaken for, and does not read like, an invalid configuration", () => {
    expect(() => assertMeCapabilities({})).toThrow(IncompatibleMeError);
    let config: unknown;
    try {
      assertDeclaredSpacesValid({ ME_NAMESPACE: "bad_space!" });
    } catch (error) {
      config = error;
    }
    expect(config).toBeInstanceOf(Error);
    expect(config).not.toBeInstanceOf(IncompatibleMeError);
    expect((config as Error).message).not.toMatch(/Incompatible this\.me/);
  });

  it("package.json declares the same floor the startup check states", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["this.me"]).toBe(`^${REQUIRED_ME.version}`);
  });
});
