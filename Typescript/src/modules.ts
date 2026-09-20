import path from "node:path";
import { pathToFileURL } from "node:url";
import type express from "express";
import type { MonadBootstrapResult, MonadRuntimeConfig } from "./bootstrap.js";

/**
 * Packages that add routes to a monad.
 *
 * A monad answers for one namespace; what else it serves (a gateway's admin
 * API, say) belongs to the package that knows it, not to the monad. So a monad
 * can be started with MONAD_MODULES="pkg,pkg/sub" and each entry exports
 * `mount(app, ctx)`: the monad imports it and hands over its express app. The
 * dependency stays one way -- the package depends on monad.ai, never the
 * reverse -- because the monad only knows a name it was given.
 *
 * Only what the person starting the monad listed is ever loaded; nothing a
 * request says reaches this. A module that cannot be loaded is reported and
 * the monad keeps serving what it has, so a broken add-on does not take the
 * namespace down with it.
 */
export interface MonadModuleContext {
  monad: MonadBootstrapResult;
  config: MonadRuntimeConfig;
}

export type MonadModuleMount = (app: express.Express, ctx: MonadModuleContext) => void | Promise<void>;

export interface MonadModulesReport {
  loaded: string[];
  failed: Array<{ specifier: string; error: string }>;
}

type Importer = (specifier: string) => Promise<any>;

const defaultImporter: Importer = (specifier) => import(specifier);

/** A path (./x, /x) is a file; anything else is a package name. */
export function toImportSpecifier(specifier: string, cwd: string): string {
  if (specifier.startsWith("file:")) return specifier;
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(cwd, specifier)).href;
  }
  return specifier;
}

export function resolveModuleMount(loaded: any): MonadModuleMount | null {
  if (typeof loaded?.mount === "function") return loaded.mount;
  if (typeof loaded?.default === "function") return loaded.default;
  if (typeof loaded?.default?.mount === "function") return loaded.default.mount;
  return null;
}

export async function loadMonadModules(
  app: express.Express,
  ctx: MonadModuleContext,
  specifiers: string[] = ctx.config.modules,
  importer: Importer = defaultImporter,
): Promise<MonadModulesReport> {
  const report: MonadModulesReport = { loaded: [], failed: [] };
  for (const specifier of specifiers) {
    try {
      const loaded = await importer(toImportSpecifier(specifier, ctx.config.cwd));
      const mount = resolveModuleMount(loaded);
      if (!mount) throw new Error("exports no mount(app, ctx)");
      await mount(app, ctx);
      report.loaded.push(specifier);
    } catch (error: any) {
      const message = error?.message || String(error);
      report.failed.push({ specifier, error: message });
      // eslint-disable-next-line no-console
      console.error(`[monad] module "${specifier}" was not mounted: ${message}`);
    }
  }
  return report;
}
