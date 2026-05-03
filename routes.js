function buildMonadLeftBarLogo() {
  const React = window.React;
  if (!React || typeof React.createElement !== "function") return null;

  return React.createElement(
    "a",
    {
      href: "/",
      title: "monad.ai",
      "aria-label": "monad.ai",
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        minHeight: "56px",
        color: "inherit",
        textDecoration: "none",
      },
    },
    React.createElement("img", {
      src: "/gui/GUI.png",
      alt: "monad.ai",
      style: {
        width: "42px",
        height: "42px",
        objectFit: "contain",
        display: "block",
      },
    })
  );
}

function buildMonadRootSurface({ gui, boot }) {
  const GUI = gui || window.GUI;
  const collections = GUI && GUI.SideBarsCollections;
  const createGUISettings =
    collections && typeof collections.GUISettings === "function"
      ? collections.GUISettings
      : typeof GUI?.GUISettings === "function"
        ? GUI.GUISettings
        : null;
  const leftBarLogo = buildMonadLeftBarLogo();

  const leftBar = {
    initialView: "rail",
    elements: leftBarLogo ? [{ type: "action", props: { element: leftBarLogo } }] : [],
    footerCollections: createGUISettings
      ? [
          createGUISettings({
            includeRuntimeControlsToggle: false,
            brandHref: "/",
            brandLogoSrc: "/gui/GUI.png",
            brandLogoAlt: "monad.ai",
            brandTooltip: "monad.ai",
            brandImageSx: {
              width: 36,
              height: 36,
              opacity: 0.9,
            },
            onOpenThemes() {
              window.location.href = "https://neurons-me.github.io/themes.html";
            },
          }),
        ]
      : [],
  };

  return {
    type: "Layout",
    props: {
      leftBar,
      rightBar: false,
      topBar: false,
      footer: false,
    },
    children: {
      type: "Namespace",
      props: {
        endpoint: boot?.apiOrigin || window.location.origin,
        rootHostNamespace: boot?.namespace || "",
        surfaceNamespace: boot?.surfaceEntry?.namespace || boot?.namespace || "",
        namespaceHandle: boot?.surfaceEntry?.rootName || boot?.namespace || "",
        resolverHostName: boot?.resolverHostName || "",
        resolverDisplayName: boot?.resolverDisplayName || "",
        namespaceUrl: boot?.surfaceEntry?.endpoint || boot?.origin || "",
      },
    },
  };
}

export function registerMonadRoutes(router, { provider, namespace, gui, boot }) {
  if (!router || typeof router.get !== "function") {
    throw new Error("Monad router missing");
  }
  if (!provider || typeof provider.getSurface !== "function") {
    throw new Error("NamespaceProvider missing");
  }

  router.get("/", function resolveRootSurface() {
    return buildMonadRootSurface({
      gui,
      boot: boot || window.__MONAD_NAMESPACE_PROVIDER_BOOT__ || null,
    });
  });

  router.get("*", function resolveSemanticSurface({ path }) {
    return provider.getSurface(namespace, path || "/");
  });
}
