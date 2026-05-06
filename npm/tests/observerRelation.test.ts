/**
 * observerRelation.test.ts — Multi-Perspective Namespace Routing
 *
 * WHAT IS AN OBSERVER RELATION?
 * In monad.ai, you can read data from one namespace WHILE identifying yourself
 * as being from another namespace. This is called an "observer relation":
 *
 *   GET /profile?as=bella    (hosted at ana.cleaker.me)
 *
 * Meaning: "I am bella looking at ana's profile."
 *
 * This creates an observer relation:
 *   target namespace:   ana.cleaker.me  (who we're reading from)
 *   observer namespace: bella.cleaker.me (who's doing the reading)
 *
 * The NRP address encodes both:
 *   "me://ana.cleaker.me:read/profile?as=bella.cleaker.me"
 *
 * WHY DOES THIS MATTER?
 * Some data in a namespace is personalized based on WHO is reading:
 *   - Ana's friends list shows different data to bella vs. a stranger
 *   - A shared resource shows different permissions to the owner vs. a viewer
 *   - Social features need to know both parties to determine relationships
 *
 * KEY CONCEPTS:
 *   target namespace:   the namespace being read (stays atomic, never modified by `?as`)
 *   observer namespace: the viewer's identity (from ?as or @prefix in path)
 *   relation.mode:      "observer" (an identity ?as=user) or "view" (a named ?view=...)
 *
 * WHAT WE TEST (7 cases):
 *   1. x-forwarded-host takes precedence over proxy host
 *   2. ?as=bella creates an observer relation without changing target namespace
 *   3. localhost path with @prefix creates an observer on the local root domain
 *   4. Namespace identity normalization for localhost paths
 *   5. Direct daemon hostname routing (monad-7f3a.local style)
 *   6. Local host alias → MONAD_SELF_IDENTITY namespace
 *   7. Legacy ?view=name (non-identity observer relation)
 */

import { createEnvelope } from "../src/http/envelope";
import { normalizeHttpRequestToMeTarget } from "../src/http/meTarget";
import {
  formatObserverRelationLabel,
  resolveNamespace,
  resolveNamespaceProjectionRoot,
  resolveObserverRelation,
} from "../src/http/namespace";
import {
  normalizeNamespaceIdentity,
  normalizeNamespaceRootName,
  parseNamespaceIdentityParts,
} from "../src/namespace/identity";

// Helper: build a minimal fake HTTP request object for testing.
// Real Express req objects have many more fields, but these tests only need:
//   headers.host, method, path, query, body.
function makeRequest(input: {
  host: string;
  path: string;
  method?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}) {
  return {
    headers: {
      host: input.host,
    },
    method: input.method || "GET",
    path: input.path,
    query: input.query || {},
    body: input.body || {},
  } as any;
}

describe("observer relation routing", () => {
  // localRoot is what "localhost" maps to after normalization.
  // The normalizer converts "localhost" → a stable, canonical form (e.g., "localhost.local")
  // so that local paths work consistently across different OS/DNS configurations.
  const localRoot = normalizeNamespaceRootName("localhost");

  it("prefers the forwarded public host over the proxy host", () => {
    // WHAT: A request arrives at a reverse proxy (netget.site), but
    //       the real intended namespace is in x-forwarded-host: "cleaker.me".
    //
    // resolveNamespace(req) → should return "cleaker.me" (not "netget.site")
    // The NRP target should be: "me://cleaker.me:read/profile"
    //
    // WHY: When monad.ai runs behind a proxy (e.g., netget, nginx, Cloudflare),
    //      the proxy's hostname appears in `Host` but the actual intended namespace
    //      is in `x-forwarded-host`. We must use the forwarded host to route correctly.
    //
    //      Without this, all requests through a proxy would route to the proxy's namespace
    //      instead of the user's actual namespace.
    const req = {
      headers: {
        host: "netget.site",
        "x-forwarded-host": "cleaker.me",
      },
      method: "GET",
      path: "/profile",
      query: {},
      body: {},
    } as any;

    expect(resolveNamespace(req)).toBe("cleaker.me");

    const target = normalizeHttpRequestToMeTarget(req);
    expect(target.namespace).toBe("cleaker.me");
    expect(target.nrp).toBe("me://cleaker.me:read/profile");
  });

  it("keeps the target namespace atomic and projects ?as onto the observer namespace", () => {
    // WHAT: GET /profile?as=bella at host ana.cleaker.me
    //
    // The TARGET namespace is ana.cleaker.me (who we're reading from).
    // The OBSERVER namespace is bella.cleaker.me (who's doing the reading).
    // "bella" expands to "bella.cleaker.me" because the space (.cleaker.me) is inherited.
    //
    // resolveNamespace(req) → "ana.cleaker.me"  (target, unchanged)
    // resolveObserverRelation(req) → {
    //   operator: "?",         (query parameter notation)
    //   mode: "observer",      (identity-based, not just a view name)
    //   value: "bella",        (raw ?as value)
    //   observer: "bella",     (extracted handle)
    //   namespace: "bella.cleaker.me"  (fully qualified observer)
    // }
    // NRP: "me://ana.cleaker.me:read/profile?as=bella.cleaker.me"
    //
    // WHY: The target namespace NEVER changes due to ?as. If it did, reading
    //      ana's profile as bella would incorrectly route to bella's data store.
    //      We need to read ana's data AND know that bella is the viewer.
    const req = makeRequest({
      host: "ana.cleaker.me",
      path: "/profile",
      query: { as: "bella" },
    });

    expect(resolveNamespace(req)).toBe("ana.cleaker.me");

    const relation = resolveObserverRelation(req);
    expect(relation).toEqual({
      operator: "?",
      mode: "observer",
      value: "bella",
      observer: "bella",
      namespace: "bella.cleaker.me",
    });
    expect(formatObserverRelationLabel(relation)).toBe("as:bella.cleaker.me");

    const target = normalizeHttpRequestToMeTarget(req);
    expect(target.nrp).toBe("me://ana.cleaker.me:read/profile?as=bella.cleaker.me");

    // The envelope carries the relation so downstream handlers know both parties
    const envelope = createEnvelope(target, { namespace: "ana.cleaker.me" }) as any;
    expect(envelope.target.relation).toEqual(relation);
  });

  it("projects the observer onto localhost without polluting the target namespace", () => {
    // WHAT: localhost:8161 with path "/@ana/profile" and ?as=@bella
    //
    // The @ prefix in the path is a local user shorthand:
    //   /@ana/profile → target namespace = ana.<localRoot>
    // The @bella in ?as → observer = bella.<localRoot>
    //
    // IMPORTANT: target namespace stays as "ana.<localRoot>"
    // The "bella" in ?as does NOT change the target — it only sets the observer.
    //
    // WHY: On a local machine (localhost), multiple users coexist in the same
    //      daemon using their localRoot namespace. The @prefix syntax lets you
    //      address them. The observer relation must work the same way locally
    //      as it does on a public domain.
    const req = makeRequest({
      host: "localhost:8161",
      path: "/@ana/profile",
      query: { as: "@bella" },
    });

    expect(resolveNamespace(req)).toBe(`ana.${localRoot}`);

    const relation = resolveObserverRelation(req);
    expect(relation).toEqual({
      operator: "?",
      mode: "observer",
      value: "@bella",
      observer: "bella",
      namespace: `bella.${localRoot}`,
    });

    const target = normalizeHttpRequestToMeTarget(req);
    expect(target.namespace).toBe(`ana.${localRoot}`);
    expect(target.path).toBe("profile");
    expect(target.nrp).toBe(`me://ana.${localRoot}:read/profile?as=bella.${localRoot}`);
  });

  it("uses the cleaker namespace parser for localhost-derived identities", () => {
    // WHAT: Verify that localhost-derived namespaces follow the same rules as
    //       cleaker.me namespaces — they just use localRoot instead of "cleaker.me".
    //
    // normalizeNamespaceIdentity("ana.localhost") → "ana.<localRoot>"
    // resolveNamespaceProjectionRoot("ana.<localRoot>") → localRoot
    // parseNamespaceIdentityParts("ana.localhost") → {
    //   host: localRoot,       (the root domain)
    //   username: "ana",       (the user handle)
    //   effective: "@ana.<localRoot>"  (the canonical form with @ prefix)
    // }
    //
    // WHY: The rest of the codebase expects all namespaces (local or remote) to
    //      follow the same identity format. Consistency means the same code
    //      handles "ana.cleaker.me" and "ana.localhost.local" without special cases.
    expect(normalizeNamespaceIdentity("ana.localhost")).toBe(`ana.${localRoot}`);
    expect(resolveNamespaceProjectionRoot(`ana.${localRoot}`)).toBe(localRoot);
    expect(parseNamespaceIdentityParts("ana.localhost")).toEqual({
      host: localRoot,
      username: "ana",
      effective: `@ana.${localRoot}`,
    });
  });

  it("resolves direct daemon hostnames without going through localhost aliasing", () => {
    // WHAT: The host is "ana.monad-7f3a.local:8161" — a direct Bonjour/mDNS hostname.
    //       This is not localhost, not a cleaker.me space, but a direct .local address.
    //
    // resolveNamespace → "ana.monad-7f3a.local"
    // NRP: "me://ana.monad-7f3a.local:read/profile.name"
    //   (path "profile/name" → dot notation "profile.name")
    //
    // WHY: Bonjour (mDNS) hostnames like "macbook-air.local" are used for LAN
    //      routing without DNS. When one monad talks to another on the same LAN,
    //      it might use the direct .local hostname. The resolver must handle this
    //      without trying to map it through the localhost alias system.
    const req = makeRequest({
      host: "ana.monad-7f3a.local:8161",
      path: "/profile/name",
    });

    expect(resolveNamespace(req)).toBe("ana.monad-7f3a.local");

    const target = normalizeHttpRequestToMeTarget(req);
    expect(target.namespace).toBe("ana.monad-7f3a.local");
    expect(target.nrp).toBe("me://ana.monad-7f3a.local:read/profile.name");
  });

  it("maps local host aliases onto the configured self identity namespace", () => {
    // WHAT: The machine's mDNS hostname is "suis-macbook-air.local".
    //       MONAD_SELF_IDENTITY is configured as "monad-9f094393.local".
    //       A request arriving with Host: "suis-macbook-air.local:8161" should
    //       be resolved to the self identity namespace ("monad-9f094393.local"),
    //       NOT to "suis-macbook-air.local" literally.
    //
    // WHY: The machine hostname and the daemon identity are two different things.
    //      The daemon has a stable cryptographic identity ("monad-9f094393.local")
    //      that doesn't change even if the machine is renamed or has multiple network
    //      interfaces. Requests to the machine's hostname should be aliased to the
    //      daemon's stable identity.
    //
    //      This is configured via MONAD_SELF_HOSTNAME = "suis-macbook-air.local"
    //      (the machine hostname) and MONAD_SELF_TAGS includes it for alias matching.

    const previousIdentity = process.env.MONAD_SELF_IDENTITY;
    const previousHostname = process.env.MONAD_SELF_HOSTNAME;
    const previousEndpoint = process.env.MONAD_SELF_ENDPOINT;
    const previousTags = process.env.MONAD_SELF_TAGS;

    process.env.MONAD_SELF_IDENTITY = "monad-9f094393.local";
    process.env.MONAD_SELF_HOSTNAME = "suis-macbook-air.local";
    process.env.MONAD_SELF_ENDPOINT = "http://localhost:8161";
    process.env.MONAD_SELF_TAGS = "local,primary,suis-macbook-air.local,localhost";

    try {
      const req = makeRequest({
        host: "suis-macbook-air.local:8161",
        path: "/profile/name",
      });

      // The host alias maps to the daemon's stable identity
      expect(resolveNamespace(req)).toBe("monad-9f094393.local");

      const target = normalizeHttpRequestToMeTarget(req);
      expect(target.namespace).toBe("monad-9f094393.local");
      expect(target.nrp).toBe("me://monad-9f094393.local:read/profile.name");
    } finally {
      // Always restore env vars, even if the test throws
      if (previousIdentity === undefined) delete process.env.MONAD_SELF_IDENTITY;
      else process.env.MONAD_SELF_IDENTITY = previousIdentity;
      if (previousHostname === undefined) delete process.env.MONAD_SELF_HOSTNAME;
      else process.env.MONAD_SELF_HOSTNAME = previousHostname;
      if (previousEndpoint === undefined) delete process.env.MONAD_SELF_ENDPOINT;
      else process.env.MONAD_SELF_ENDPOINT = previousEndpoint;
      if (previousTags === undefined) delete process.env.MONAD_SELF_TAGS;
      else process.env.MONAD_SELF_TAGS = previousTags;
    }
  });

  it("preserves legacy named views as a non-identity relation", () => {
    // WHAT: GET /profile?view=friends at ana.cleaker.me
    //
    // ?view=friends is a NAMED VIEW, not an identity observer.
    // The relation has:
    //   mode: "view"     (not "observer" — no identity involved)
    //   value: "friends" (the view name)
    //   observer: null   (no viewer identity)
    //   namespace: null  (no viewer namespace)
    //
    // NRP: "me://ana.cleaker.me:read/profile?view=friends"
    //   (note: no namespace expansion because view is not an identity)
    //
    // WHY: Some views are named (like tabs in a UI: "friends", "posts", "about").
    //      They're not about WHO is viewing — they're about WHICH version of the
    //      data to show. The observer relation system handles both modes:
    //      identity-based (?as=user) and name-based (?view=name).
    //
    // formatObserverRelationLabel({mode:"view", value:"friends"}) → "friends"
    // (no namespace prefix because it's a named view, not an identity)
    const req = makeRequest({
      host: "ana.cleaker.me",
      path: "/profile",
      query: { view: "friends" },
    });

    const relation = resolveObserverRelation(req);
    expect(relation).toEqual({
      operator: "?",
      mode: "view",
      value: "friends",
      observer: null,
      namespace: null,
    });

    const target = normalizeHttpRequestToMeTarget(req);
    expect(formatObserverRelationLabel(target.relation)).toBe("friends");
    expect(target.nrp).toBe("me://ana.cleaker.me:read/profile?view=friends");
  });
});
