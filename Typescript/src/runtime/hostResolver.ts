import {
  parseCanonicalMeUri,
  projectDnsHostToNamespace,
  type MeDnsProjectionFailureReason,
} from "this.me";
// A namespace import, not a named one: against a this.me that predates validateKnownSpaces a named import is
// a link-time SyntaxError nobody can read. This way startup can say what is actually missing.
import * as ThisMe from "this.me";

export interface ResolveHostToMeUriOptions {
  knownSpaces?: readonly string[];
}

export type ResolveHostToMeUriResult =
  | {
      ok: true;
      kind: "space";
      host: string;
      namespace: string;
      space: string;
      canonical: null;
      knownSpaces: string[];
    }
  | {
      ok: true;
      kind: "namespace";
      host: string;
      namespace: string;
      handle: string;
      space: string;
      canonical: string;
      knownSpaces: string[];
    }
  | {
      ok: false;
      host: string;
      reason: MeDnsProjectionFailureReason;
      matchedSpace: string | null;
      prefixLabels: string[];
      knownSpaces: string[];
    };

/**
 * What this monad needs from this.me, stated once. package.json carries the same floor as a range
 * (`this.me: ^4.2.0`), so an incompatible install is refused when dependencies are resolved; this
 * is the check that still answers if one gets through, and it says what is missing instead of failing on an
 * undefined function somewhere later.
 */
export const REQUIRED_ME = {
  version: "4.2.0",
  feature: "runtime-declared spaces",
  capabilities: ["validateKnownSpaces", "parseMeSpaceUri", "tryParseMeSpaceUri"],
} as const;

/** The installed this.me cannot do what this monad needs. A different fault from a bad configuration. */
export class IncompatibleMeError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Incompatible this.me: monad.ai needs this.me >= ${REQUIRED_ME.version} (${REQUIRED_ME.feature}); ` +
        `the installed one does not provide: ${missing.join(", ")}. ` +
        "Update this.me together with monad.ai (see the README, \"Requires this.me\").",
    );
    this.name = "IncompatibleMeError";
    this.missing = missing;
  }
}

/**
 * Refuses an installed this.me that lacks what this monad calls. Runs on every start, whatever is declared:
 * a monad that happens to declare nothing today is still running against the wrong kernel.
 */
export function assertMeCapabilities(me: Record<string, unknown> = ThisMe as unknown as Record<string, unknown>): void {
  const missing = REQUIRED_ME.capabilities.filter((name) => typeof me[name] !== "function");
  if (missing.length > 0) throw new IncompatibleMeError([...missing]);
}

/**
 * Where a runtime declares the spaces it serves. The host resolver and the startup check both read THIS list,
 * so what is validated at boot is exactly what requests are later resolved against.
 */
export const DECLARED_SPACE_ENV = ["ME_NAMESPACE", "MONAD_LOCAL_ALIAS_ROOT", "MONAD_CANONICAL_SPACE"] as const;

export type DeclaredSpace = {
  source: (typeof DECLARED_SPACE_ENV)[number];
  value: string;
};

export function readDeclaredSpaces(env: Record<string, string | undefined> = process.env): DeclaredSpace[] {
  const declared: DeclaredSpace[] = [];
  for (const source of DECLARED_SPACE_ENV) {
    const value = String(env[source] || "").trim();
    if (value) declared.push({ source, value });
  }
  return declared;
}

/**
 * Startup check: every declared space must be one the contract in this.me accepts (it decides what is valid,
 * including folding case). Throws naming the variable, so a bad declaration stops the monad where it is
 * configured instead of failing every request resolved against it. Pass the env that is ABOUT to be applied
 * to validate it before anything is written.
 */
export function assertDeclaredSpacesValid(env: Record<string, string | undefined> = process.env): string[] {
  const declared = readDeclaredSpaces(env);
  if (declared.length === 0) return [];
  for (const { source, value } of declared) {
    try {
      ThisMe.validateKnownSpaces([value]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${source}=${JSON.stringify(value)} is not a valid space: ${reason}`);
    }
  }
  return declared.map((entry) => entry.value);
}

/**
 * Reads an expression as a reference to a space this runtime DECLARED (`me://here`, or the bare `here`),
 * using the same declared list the resolver and the startup check use. Returns null for anything else,
 * including every runtime that declares nothing: without that context a bare name is never taken to be a
 * space. This is how an entry point tells the root form (`me://<space>`) from the handle form
 * (`me://<handle>.<space>`) without guessing.
 */
export function declaredSpaceReference(
  expression: string,
  env: Record<string, string | undefined> = process.env,
): { space: string } | null {
  const declared = readDeclaredSpaces(env).map((entry) => entry.value);
  if (declared.length === 0) return null;
  const text = String(expression ?? "").trim();
  if (!text) return null;
  const asUri = text.toLowerCase().startsWith("me://") ? text : `me://${text}`;
  const parsed = ThisMe.tryParseMeSpaceUri(asUri, { knownSpaces: declared });
  return parsed ? { space: parsed.space } : null;
}

function collectKnownSpaces(options: ResolveHostToMeUriOptions): string[] {
  const rawValues = [
    ...(options.knownSpaces || []),
    ...readDeclaredSpaces().map((entry) => entry.value),
  ];

  const seen = new Set<string>();
  const knownSpaces: string[] = [];
  for (const raw of rawValues) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    knownSpaces.push(value);
  }
  return knownSpaces;
}

export function resolveHostToMeUri(
  rawHost: string,
  options: ResolveHostToMeUriOptions = {},
): ResolveHostToMeUriResult {
  const knownSpaces = collectKnownSpaces(options);
  const projection = projectDnsHostToNamespace(rawHost, knownSpaces);

  if (!projection.ok) {
    return {
      ok: false,
      host: projection.host,
      reason: projection.reason,
      matchedSpace: projection.matchedSpace,
      prefixLabels: projection.prefixLabels,
      knownSpaces,
    };
  }

  if (projection.kind === "space") {
    return {
      ok: true,
      kind: "space",
      host: projection.host,
      namespace: projection.space,
      space: projection.space,
      canonical: null,
      knownSpaces,
    };
  }

  const parsed = parseCanonicalMeUri(projection.uri, { knownSpaces });
  return {
    ok: true,
    kind: "namespace",
    host: projection.host,
    namespace: parsed.namespace,
    handle: parsed.handle,
    space: parsed.space,
    canonical: parsed.href,
    knownSpaces,
  };
}

export function resolveHostToCanonicalNamespace(
  rawHost: string,
  options: ResolveHostToMeUriOptions = {},
): string | null {
  const resolved = resolveHostToMeUri(rawHost, options);
  if (!resolved.ok) return null;
  return resolved.namespace;
}
