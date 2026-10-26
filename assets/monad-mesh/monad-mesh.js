// /monad/ root: the .GUI monad card from this.gui — the monad.ai orb (GUI.Monad) on top and the monad mesh
// (GUI.MonadMesh) below, every monad live. Same structure and styles as GUI.MonadNamespaceCard in this.gui@4.2.0;
// built from its two parts here only because 4.2.0's card does not take meshDefaultOpen yet (the mesh would start
// collapsed). When a this.gui release has it, this can become
// h(G.MonadNamespaceCard, { healthy: true, apps, meshDefaultOpen: true }).
(function () {
  var G = window.GUI, root = document.getElementById("monad-mesh-root");
  if (!G || !window.React || !window.ReactDOM || !G.Monad || !G.MonadMesh || !root) return;
  var h = React.createElement, Box = (G.Atoms && G.Atoms.Box) || G.Box;
  var mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  var apps = [
    { name: "monad:cleaker", port: 4101, healthy: true },
    { name: "monad:netget", port: 4102, healthy: true },
    { name: "monad:cold-store", port: 4103, healthy: true }
  ];
  var cardSx = { position: "relative", width: "100%", borderRadius: 3, border: "1px solid", borderColor: "divider", background: "background.paper", overflow: "hidden" };
  var card = h(Box, { sx: { display: "flex", flexDirection: "column", gap: 1 } },
    h(Box, { sx: cardSx },
      h(Box, { sx: { height: 130, display: "flex", alignItems: "center", justifyContent: "center" } },
        h(G.Monad, { mode: "contained", kind: "monad", label: "monad.ai", healthy: true })),
      h(Box, { sx: { borderTop: "1px solid", borderColor: "divider", px: 2, py: 1.5 } },
        h(G.MonadMesh, { apps: apps, sleepingEntries: [], defaultOpen: true }))));
  ReactDOM.createRoot(root).render(G.Theme ? h(G.Theme, { initialThemeId: "neurons.me", initialMode: mode }, card) : card);
})();
