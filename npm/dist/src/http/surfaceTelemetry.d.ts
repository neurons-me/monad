import type express from "express";
export type SurfaceRequestEvent = {
    id: number;
    timestamp: number;
    method: string;
    url: string;
    status: number;
    durationMs: number;
    host: string;
    namespace: string;
    operation: string;
    nrp: string;
    lens: string;
    forwardedHost: string | null;
};
export type SurfaceTelemetrySnapshot = {
    usage: {
        cpu: number;
        requestRatePer10s: number;
    };
    pressure: {
        cpu: number;
    };
    policy: {
        gui: {
            blockchain: {
                limit: number;
            };
        };
    };
    budget: {
        gui: {
            blockchain: {
                rows: number;
            };
        };
    };
    monitor: {
        recentRequests: SurfaceRequestEvent[];
    };
};
type SurfaceRequestInput = Omit<SurfaceRequestEvent, "id" | "timestamp"> & {
    timestamp?: number;
};
export declare function getSurfaceTelemetrySnapshot(): SurfaceTelemetrySnapshot;
export declare function recordSurfaceRequest(input: SurfaceRequestInput): void;
export declare function attachSurfaceStreamClient(req: express.Request, res: express.Response): void;
export {};
