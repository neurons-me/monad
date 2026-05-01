import type express from "express";
export declare function resolveRequestOrigin(req: express.Request, fallbackHost?: string): string;
export declare function resolveRequestSurfaceRoute(req: express.Request): string;
