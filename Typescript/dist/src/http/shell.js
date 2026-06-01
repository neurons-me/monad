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
    const namespaceTitle = providerBoot?.namespace || "namespace";
    // Dev mode: serve a Vite-compatible shell that loads ES modules with HMR.
    const viteDevUrl = process.env.MONAD_GUI_DEV_URL?.replace(/\/+$/, "");
    if (viteDevUrl) {
        const devHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="icon" type="image/png" href="/gui/favicon.png" />
    <title>${namespaceTitle}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/gui/@vite/client"></script>
    <script type="module" src="/gui/src/dev-entry.tsx"></script>
  </body>
</html>`;
        return providerBoot ? injectNamespaceProviderShell(devHtml, providerBoot) : devHtml;
    }
    const indexPath = getMonadIndexPath();
    try {
        if (fs.existsSync(indexPath)) {
            let html = fs.readFileSync(indexPath, "utf8");
            html = html.replace(/<title>[^<]*<\/title>/, `<title>${namespaceTitle}</title>`);
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
    <link rel="icon" type="image/png" href="/gui/favicon.png" />
    <link rel="stylesheet" href="/gui/styles.css" />
    <link rel="stylesheet" href="https://unpkg.com/this.gui@2.1.8/dist/styles.css" />
    <title>${namespaceTitle}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      const loadScript = (src) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(script);
      });

      const loadFirst = async (...sources) => {
        let lastError = null;
        for (const src of sources) {
          try {
            await loadScript(src);
            return src;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('No script sources provided');
      };

      const importFirst = async (...sources) => {
        let lastError = null;
        for (const src of sources) {
          try {
            await import(src);
            return src;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('No module sources provided');
      };

      if (!globalThis.process) {
        globalThis.process = { env: { NODE_ENV: 'production' } };
      } else if (!globalThis.process.env) {
        globalThis.process.env = { NODE_ENV: 'production' };
      } else if (!('NODE_ENV' in globalThis.process.env)) {
        globalThis.process.env.NODE_ENV = 'production';
      }
      await loadFirst(
        '/vendor/react/react.production.min.js',
        'https://unpkg.com/react@18.3.1/umd/react.production.min.js'
      );
      await loadFirst(
        '/vendor/react-dom/react-dom.production.min.js',
        'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'
      );
      const React = globalThis.React;
      const ReactDOM = globalThis.ReactDOM;
      if (!React) throw new Error('React global is missing. Failed to load react.production.min.js');
      if (!ReactDOM) throw new Error('ReactDOM global is missing. Failed to load react-dom.production.min.js');
      await importFirst(
        '/gui/this.gui.umd.js',
        'https://unpkg.com/this.gui@2.1.8/dist/this.gui.umd.js'
      );
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
