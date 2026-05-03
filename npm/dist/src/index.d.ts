import type { Server } from "node:http";
import { createMonadApp, type MonadApp } from "./app.js";
import { bootstrapMonad, type MonadBootstrapResult, type MonadLogger, type MonadOptions, type MonadRuntimeConfig } from "./bootstrap.js";
import type { SelfNodeConfig, SelfSurfaceCapacity, SelfSurfaceTrust, SelfSurfaceType } from "./http/selfMapping.js";
export interface StartMonadOptions extends MonadOptions {
    setupPersistence?: boolean;
}
export interface StartMonadResult {
    app: MonadApp;
    server: Server;
    bootstrap: MonadBootstrapResult;
}
export declare function startMonad(options?: StartMonadOptions): Promise<StartMonadResult>;
export { createMonadApp, bootstrapMonad };
export type { MonadApp, MonadBootstrapResult, MonadLogger, MonadOptions, MonadRuntimeConfig, SelfNodeConfig, SelfSurfaceCapacity, SelfSurfaceTrust, SelfSurfaceType, };
