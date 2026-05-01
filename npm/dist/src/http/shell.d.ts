import type express from "express";
import { type NamespaceProviderBoot } from "./provider.js";
export interface MonadShellConfig {
    cwd?: string;
    guiPkgDistDir?: string;
    indexPath?: string;
}
export declare function configureMonadShell(config: MonadShellConfig): void;
export declare function getGuiPkgDistDir(): string;
export declare function getMonadIndexPath(): string;
export declare const GUI_PKG_DIST_DIR: string;
export declare const MONAD_INDEX_PATH: string;
export declare function wantsHtml(req: express.Request): boolean;
export declare function htmlShell(options?: {
    providerBoot?: NamespaceProviderBoot | null;
}): string;
