export interface SelfNodeConfig {
    identity: string;
    tags: string[];
    endpoint: string;
    hostname: string;
    configPath: string;
    type?: SelfSurfaceType;
    trust?: SelfSurfaceTrust;
    resources?: string[];
    capacity?: Partial<SelfSurfaceCapacity>;
}
export type SelfSurfaceType = "desktop" | "mobile" | "server" | "browser-tab" | "node";
export type SelfSurfaceTrust = "owner" | "trusted-peer" | "guest";
export type SelfSurfaceAvailability = "online" | "offline" | "sleep" | "unknown";
export interface SelfSurfaceCapacity {
    cpuCores: number | null;
    ramGb: number | null;
    storageGb: number | null;
    bandwidthMbps: number | null;
}
export interface SelfSurfaceEntry {
    hostId: string;
    type: SelfSurfaceType;
    trust: SelfSurfaceTrust;
    resources: string[];
    capacity: SelfSurfaceCapacity;
    status: {
        availability: SelfSurfaceAvailability;
        latencyMs: number | null;
        syncState: "current" | "stale" | "unknown";
        lastSeen: number | null;
    };
    namespace: string;
    endpoint: string;
    rootName: string;
    usage?: {
        cpu: number;
        requestRatePer10s?: number;
    };
    pressure?: {
        cpu: number;
    };
    policy?: {
        gui?: {
            blockchain?: {
                limit?: number;
            };
        };
    };
    budget?: {
        gui?: {
            blockchain?: {
                rows?: number;
            };
        };
    };
    monitor?: {
        recentRequests?: Array<{
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
        }>;
    };
}
export type SelfDispatchMode = "unconfigured" | "foreign" | "local" | "remote" | "unscoped";
export interface SelfDispatchResult {
    mode: SelfDispatchMode;
    configured: boolean;
    identity: string | null;
    base: string;
    selectorRaw: string | null;
    hasInstanceSelector: boolean;
    matched: string[];
    required: string[];
    endpoint: string | null;
    tags: string[];
    reason: string;
}
type SelectorClause = {
    type: string;
    values: string[];
};
export declare function buildSelfSurfaceEntry(input: {
    self: SelfNodeConfig | null;
    origin: string;
    fallbackHost: string;
    requestNamespace: string;
    now?: number;
}): SelfSurfaceEntry;
export declare function parseSelectorGroups(selectorRaw: string | null): SelectorClause[][];
export declare function loadSelfNodeConfig(input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    hostname: string;
    port: string | number;
}): SelfNodeConfig | null;
export declare function resolveSelfDispatch(baseInput: string, selectorRawInput: string | null, self: SelfNodeConfig | null): SelfDispatchResult;
export {};
