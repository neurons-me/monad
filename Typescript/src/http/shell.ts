import type express from "express";
import path from "path";
import fs from "fs";
import {
  injectNamespaceProviderShell,
  type NamespaceProviderBoot,
} from "./provider.js";

export interface MonadShellConfig {
  cwd?: string;
  guiPkgDistDir?: string;
  indexPath?: string;
}

let shellConfig: MonadShellConfig = {};

export function configureMonadShell(config: MonadShellConfig): void {
  shellConfig = { ...shellConfig, ...config };
}

export function getGuiPkgDistDir(): string {
  return path.resolve(
    shellConfig.cwd || process.cwd(),
    shellConfig.guiPkgDistDir || process.env.GUI_PKG_DIST_DIR || "../../../this/GUI/npm/dist",
  );
}

/** The interface this monad serves: its front end's index.html, or one named outright. "" = none configured. */
export function getMonadIndexPath(): string {
  const named = shellConfig.indexPath || process.env.MONAD_INDEX_PATH || "";
  return named ? path.resolve(shellConfig.cwd || process.cwd(), named) : "";
}

export const GUI_PKG_DIST_DIR = getGuiPkgDistDir();
export const MONAD_INDEX_PATH = getMonadIndexPath();

export function wantsHtml(req: express.Request) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

export function htmlShell(options: { providerBoot?: NamespaceProviderBoot | null } = {}) {
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
    if (indexPath && fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, "utf8");
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${namespaceTitle}</title>`);
      return providerBoot ? injectNamespaceProviderShell(html, providerBoot) : html;
    }
  } catch {
    // fall back to inline shell
  }
  // No interface configured: the same minimal page every gateway screen is (one tree), with cleaker.js (this.gui's
  // standalone QR corner) -- not a second interface of the monad's own.
  const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${namespaceTitle}</title>
    <style>
      :root { color-scheme: light dark; --bg: #f4f6f7; --fg: #0f1720; --muted: #5b6b78; }
      @media (prefers-color-scheme: dark) { :root { --bg: #0d1214; --fg: #e8eded; --muted: #98a7b3; } }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
        font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      main { max-width: 34rem; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      p { margin: .25rem 0; color: var(--muted); }
      code { font-family: ui-monospace, Menlo, monospace; color: var(--fg); }
    </style>
  </head>
  <body data-monad-state="no-interface">
    <main>
      <h1><code>${namespaceTitle}</code></h1>
      <p>This monad answers, but no interface is configured for it (<code>MONAD_FRONTEND_DIR</code>).</p>
    </main>
    <script src="https://cdn.jsdelivr.net/npm/this.gui@4.4.3/dist/cleaker.js" integrity="sha384-Um9li/v82/OE78Ni3DZ+gk9nkZCMW+tKndOE0BshBDa0rzCUAetKCxkE1dvEDhMz" crossorigin="anonymous" data-corner="top-right"></script>
  </body>
</html>`;
  return providerBoot ? injectNamespaceProviderShell(fallbackHtml, providerBoot) : fallbackHtml;
}
