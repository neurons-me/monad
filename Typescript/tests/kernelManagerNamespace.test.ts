import assert from "node:assert/strict";
import { describe, it, afterEach } from "vitest";
import { kernelPathFor, namespaceToKernelPrefix } from "../src/kernel/manager";

const ORIGINAL_ENV = {
  ME_NAMESPACE: process.env.ME_NAMESPACE,
  MONAD_SELF_IDENTITY: process.env.MONAD_SELF_IDENTITY,
  MONAD_SELF_HOSTNAME: process.env.MONAD_SELF_HOSTNAME,
  MONAD_LOCAL_ALIAS_ROOT: process.env.MONAD_LOCAL_ALIAS_ROOT,
};

function setRootNamespace(root: string) {
  process.env.ME_NAMESPACE = root;
  delete process.env.MONAD_SELF_IDENTITY;
  delete process.env.MONAD_SELF_HOSTNAME;
  delete process.env.MONAD_LOCAL_ALIAS_ROOT;
}

afterEach(() => {
  for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("namespaceToKernelPrefix", () => {
  it("projects cleaker namespace prefixes into monad user kernel paths", () => {
    setRootNamespace("suis-macbook-air.local");

    assert.equal(
      namespaceToKernelPrefix("jabellae.suis-macbook-air.local"),
      "users.jabellae",
    );
    assert.equal(
      kernelPathFor("jabellae.suis-macbook-air.local", "profile.displayName"),
      "users.jabellae.profile.displayName",
    );
  });

  it("uses cleaker's full namespace expression grammar before projecting", () => {
    setRootNamespace("suis-macbook-air.local");

    assert.equal(
      namespaceToKernelPrefix(
        "me://jabellae.suis-macbook-air.local[host:localhost|protocol:http|port:8161]:open/profile",
      ),
      "users.jabellae",
    );
  });

  it("keeps root and unknown namespaces at the kernel root", () => {
    setRootNamespace("suis-macbook-air.local");

    assert.equal(namespaceToKernelPrefix("suis-macbook-air.local"), "");
    assert.equal(namespaceToKernelPrefix("jabellae.example.com"), "");
    assert.equal(kernelPathFor("jabellae.example.com", "profile.displayName"), "profile.displayName");
  });
});
