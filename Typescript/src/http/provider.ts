import { readSemanticValueForNamespace } from "../claim/memoryStore.js";
import type { SelfSurfaceEntry } from "./selfMapping.js";

export interface NamespaceProviderBoot {
  kind: "namespace-provider";
  version: 1;
  /**
   * The namespace the address this page was loaded from resolves to: the root
   * (cleaker.me; www.cleaker.me is answered as cleaker.me) or, at a handle host,
   * that handle's own namespace (jabellae.cleaker.me).
   */
  namespace: string;
  /**
   * The namespace this monad serves -- the root every handle lives under -- whatever
   * address the page came from. A page that composes a handle's namespace uses THIS,
   * never `namespace` (at jabellae.cleaker.me that is already the handle's).
   */
  rootNamespace: string;
  /** The handle when `namespace` is <handle>.<rootNamespace>, else null (the root itself). */
  handle: string | null;
  route: string;
  origin: string;
  apiOrigin: string;
  resolverHostName: string;
  resolverDisplayName: string;
  endpoints: {
    resolve: string;
    surface: string;
    subscribe: string | null;
  };
  surfaceEntry: SelfSurfaceEntry | null;
  /**
   * The packages mounted into this monad (MONAD_MODULES that loaded), so a
   * front end can tell what kind of monad it is on -- a gateway's, or a
   * namespace's -- without probing for routes.
   */
  modules: string[];
}

function readFirstSemanticValue(namespace: string, candidates: string[]): unknown {
  for (const candidate of candidates) {
    const value = readSemanticValueForNamespace(namespace, candidate);
    if (typeof value !== "undefined") return value;
  }
  return undefined;
}

function stringifyInlineData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/-->/g, "--\\>");
}

function normalizeRouteSegment(segment: string): string {
  return String(segment || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function routeToSemanticKey(route: string): string {
  const normalized = normalizeSurfaceRoute(route);
  if (normalized === "/") return "root";
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => normalizeRouteSegment(segment))
    .filter(Boolean);
  return segments.join(".") || "root";
}

export function normalizeSurfaceRoute(route: string): string {
  const raw = String(route || "").trim();
  if (!raw) return "/";
  const withoutQuery = raw.split("?")[0]?.split("#")[0] ?? "/";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "") || "/";
}

export function buildNamespaceProviderBoot(input: {
  namespace: string;
  route: string;
  origin: string;
  resolverHostName: string;
  resolverDisplayName: string;
  surfaceEntry: SelfSurfaceEntry | null;
  modules?: string[];
  rootNamespace?: string;
}): NamespaceProviderBoot {
  const route = normalizeSurfaceRoute(input.route);
  const origin = String(input.origin || "").trim();
  const namespace = String(input.namespace || "").trim();
  const rootNamespace = String(input.rootNamespace || "").trim() || namespace;
  const handle = rootNamespace && namespace.endsWith(`.${rootNamespace}`)
    ? namespace.slice(0, -(rootNamespace.length + 1))
    : null;

  return {
    kind: "namespace-provider",
    version: 1,
    namespace,
    rootNamespace,
    handle,
    route,
    origin,
    apiOrigin: origin,
    resolverHostName: String(input.resolverHostName || "").trim(),
    resolverDisplayName: String(input.resolverDisplayName || "").trim(),
    endpoints: {
      resolve: "/__provider/resolve",
      surface: "/__provider/surface",
      subscribe: null,
    },
    surfaceEntry: input.surfaceEntry || null,
    modules: [...(input.modules ?? [])],
  };
}

function buildProviderInjectionScript(boot: NamespaceProviderBoot): string {
  const bootJson = stringifyInlineData(boot);
  return `<script>
(function () {
  window.__MONAD_PROVIDER_BOOT_INJECTED__ = true;
  var boot = ${bootJson};
  window.__MONAD_NAMESPACE_PROVIDER_BOOT__ = boot;
  window.__MONAD_NAMESPACE__ = boot.namespace;
  window.__MONAD_ROUTE__ = boot.route;
  window.__MONAD_CREATE_NAMESPACE_PROVIDER__ = function (gui) {
    var surface = gui || window.GUI;
    if (!surface || typeof surface.createHttpNamespaceProvider !== "function") {
      throw new Error("GUI.createHttpNamespaceProvider is not available yet.");
    }
    var provider = surface.createHttpNamespaceProvider(boot);
    window.__MONAD_NAMESPACE_PROVIDER__ = provider;
    return provider;
  };
  try {
    window.dispatchEvent(new CustomEvent("monad:provider-boot", { detail: boot }));
  } catch (_) {}
})();
</script>`;
}

export function injectNamespaceProviderShell(html: string, boot: NamespaceProviderBoot): string {
  const source = String(html || "");
  if (!source.trim()) return source;
  if (source.includes("__MONAD_PROVIDER_BOOT_INJECTED__")) return source;

  const injection = buildProviderInjectionScript(boot);
  if (source.includes("</head>")) {
    return source.replace("</head>", `${injection}\n</head>`);
  }
  if (source.includes("</body>")) {
    return source.replace("</body>", `${injection}\n</body>`);
  }
  return `${injection}\n${source}`;
}

function buildFallbackSurfaceSpec(input: {
  namespace: string;
  route: string;
  surfaceEntry: SelfSurfaceEntry | null;
}): Record<string, unknown> {
  const semanticKey = routeToSemanticKey(input.route);
  const titleCandidate = readFirstSemanticValue(input.namespace, [
    `surface.routes.${semanticKey}.title`,
    `surface.route.${semanticKey}.title`,
    "surface.title",
    "profile.displayName",
    "profile.name",
  ]);
  const summaryCandidate = readFirstSemanticValue(input.namespace, [
    `surface.routes.${semanticKey}.summary`,
    `surface.route.${semanticKey}.summary`,
    "surface.summary",
    "profile.summary",
    "profile.bio",
  ]);
  const title = String(titleCandidate || input.namespace || "Semantic Surface");
  const summary = String(
    summaryCandidate ||
      "Surface resolved semantically by monad.ai without schemas, queries, or GraphQL middleware."
  );
  const hostId = String(input.surfaceEntry?.hostId || "").trim();
  const rootName = String(input.surfaceEntry?.rootName || "").trim();

  return {
    type: "Box",
    props: {
      sx: {
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
        background:
          "radial-gradient(circle at top, rgba(33,150,243,0.12), transparent 45%), linear-gradient(180deg, rgba(9,14,24,1) 0%, rgba(16,24,38,1) 100%)",
      },
    },
    children: [
      {
        type: "Paper",
        props: {
          elevation: 3,
          sx: {
            width: "min(760px, 100%)",
            p: 3,
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
            background: "rgba(255,255,255,0.96)",
          },
        },
        children: [
          {
            type: "Typography",
            props: {
              variant: "overline",
              sx: {
                letterSpacing: "0.18em",
                color: "text.secondary",
              },
            },
            children: ["Namespace Provider"],
          },
          {
            type: "Typography",
            props: {
              variant: "h3",
              sx: {
                fontWeight: 800,
              },
            },
            children: [title],
          },
          {
            type: "Typography",
            props: {
              variant: "body1",
              sx: {
                color: "text.secondary",
                lineHeight: 1.7,
              },
            },
            children: [summary],
          },
          {
            type: "Typography",
            props: {
              variant: "body2",
              sx: {
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                color: "text.secondary",
              },
            },
            children: [
              `namespace: ${input.namespace}\nroute: ${normalizeSurfaceRoute(input.route)}${
                rootName ? `\nroot: ${rootName}` : ""
              }${hostId ? `\nhost: ${hostId}` : ""}`,
            ],
          },
        ],
      },
    ],
  };
}

export function resolveNamespaceSurfaceSpec(input: {
  namespace: string;
  route: string;
  surfaceEntry: SelfSurfaceEntry | null;
}): Record<string, unknown> {
  const namespace = String(input.namespace || "").trim();
  const route = normalizeSurfaceRoute(input.route);
  const semanticKey = routeToSemanticKey(route);
  const specCandidate = readFirstSemanticValue(namespace, [
    `surface.routes.${semanticKey}.spec`,
    `surface.route.${semanticKey}.spec`,
    "surface.spec",
  ]);

  if (
    specCandidate &&
    typeof specCandidate === "object" &&
    !Array.isArray(specCandidate) &&
    "type" in (specCandidate as Record<string, unknown>)
  ) {
    return specCandidate as Record<string, unknown>;
  }

  return buildFallbackSurfaceSpec({
    namespace,
    route,
    surfaceEntry: input.surfaceEntry,
  });
}
