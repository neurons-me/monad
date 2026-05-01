import { type Router as ExpressRouter } from "express";
import { type SelfNodeConfig } from "../http/selfMapping.js";
import { resolveRequestOrigin } from "../runtime/requestContext.js";
export type ProviderSurfaceConfig = {
    selfNodeConfig: SelfNodeConfig | null;
    hostname: string;
    displayName: string;
};
export declare function buildProviderBoot(req: Parameters<typeof resolveRequestOrigin>[0], namespace: string, config: ProviderSurfaceConfig): import("../http/provider.js").NamespaceProviderBoot;
export declare function createProviderSurface(config: ProviderSurfaceConfig): ExpressRouter;
