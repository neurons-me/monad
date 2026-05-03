import path from "path";
import fs from "fs";
import { injectNamespaceProviderShell, } from "./provider.js";
let shellConfig = {};
export function configureMonadShell(config) {
    shellConfig = { ...shellConfig, ...config };
}
export function getGuiPkgDistDir() {
    return path.resolve(shellConfig.cwd || process.cwd(), shellConfig.guiPkgDistDir || process.env.GUI_PKG_DIST_DIR || "../../../this/GUI/npm/dist");
}
export function getMonadIndexPath() {
    return path.resolve(shellConfig.cwd || process.cwd(), shellConfig.indexPath || process.env.MONAD_INDEX_PATH || "../index.html");
}
export const GUI_PKG_DIST_DIR = getGuiPkgDistDir();
export const MONAD_INDEX_PATH = getMonadIndexPath();
export function wantsHtml(req) {
    const accept = String(req.headers.accept || "");
    return accept.includes("text/html");
}
export function htmlShell(options = {}) {
    const providerBoot = options.providerBoot || null;
    const indexPath = getMonadIndexPath();
    try {
        if (fs.existsSync(indexPath)) {
            const html = fs.readFileSync(indexPath, "utf8");
            return providerBoot ? injectNamespaceProviderShell(html, providerBoot) : html;
        }
    }
    catch {
        // fall back to inline shell
    }
    const fallbackHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <script src="/vendor/react/react.production.min.js"></script>
    <script src="/vendor/react-dom/react-dom.production.min.js"></script>
    <link rel="icon" href="/gui/favicon.ico" />
    <link rel="stylesheet" href="/gui/styles.css" />
    <title>cleaker.me</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      if (!globalThis.process) {
        globalThis.process = { env: { NODE_ENV: 'production' } };
      } else if (!globalThis.process.env) {
        globalThis.process.env = { NODE_ENV: 'production' };
      } else if (!('NODE_ENV' in globalThis.process.env)) {
        globalThis.process.env.NODE_ENV = 'production';
      }
      const React = globalThis.React;
      const ReactDOM = globalThis.ReactDOM;
      if (!React) throw new Error('React global is missing. Failed to load react.production.min.js');
      if (!ReactDOM) throw new Error('ReactDOM global is missing. Failed to load react-dom.production.min.js');
      await import('/gui/this.gui.umd.js');
      const GUI = globalThis.ThisGUI || globalThis.thisGUI || globalThis.GUI || globalThis['this.gui'];
      const providerBoot = globalThis.__MONAD_NAMESPACE_PROVIDER_BOOT__ || null;
      let provider = null;
      if (providerBoot && typeof globalThis.__MONAD_CREATE_NAMESPACE_PROVIDER__ === 'function') {
        provider = globalThis.__MONAD_CREATE_NAMESPACE_PROVIDER__(GUI);
      }
      let surface = null;
      try {
        if (provider) {
          surface = await provider.getSurface(providerBoot.namespace, providerBoot.route);
        }
      } catch (e) {
        surface = null;
      }

      const guiRuntime = (GUI && (GUI.default || GUI.GUI || GUI)) || {};
      console.log("GUI provider boot", providerBoot);
      console.log("GUI provider", provider);
      console.log("GUI surface", surface);
      console.log("GUI runtime", guiRuntime);
      const el = document.querySelector('#app');
      if (el) {
        const pre = document.createElement('pre');
        pre.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
        pre.style.padding = '16px';
        pre.textContent = \`monad provider shell loaded\\nnamespace: \${providerBoot ? providerBoot.namespace : '-'}\\nroute: \${providerBoot ? providerBoot.route : '-'}\\n(apiOrigin: \${providerBoot ? providerBoot.apiOrigin : '-'})\\nprovider: \${provider ? 'ready' : 'missing'}\\nGUI global: \${GUI ? 'present' : 'missing'}\`;
        el.innerHTML = '';
        el.appendChild(pre);
      }
    </script>
  </body>
</html>`;
    return providerBoot ? injectNamespaceProviderShell(fallbackHtml, providerBoot) : fallbackHtml;
}
