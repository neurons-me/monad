import { type Router as ExpressRouter } from "express";
export type FetchSurfaceConfig = {
    timeoutMs: number;
};
export declare function createFetchSurface(config: FetchSurfaceConfig): ExpressRouter;
