import type { SelfSurfaceEntry } from "./selfMapping.js";
export interface NamespaceProviderBoot {
    kind: "namespace-provider";
    version: 1;
    namespace: string;
    route: string;
    origin: string;
    apiOrigin: string;
    resolverHostName: string;
    resolverDisplayName: string;
    endpoints: {
        resolve: string;
        surface: string;
        subscribe: string | null;
    };
    surfaceEntry: SelfSurfaceEntry | null;
}
export declare function normalizeSurfaceRoute(route: string): string;
export declare function buildNamespaceProviderBoot(input: {
    namespace: string;
    route: string;
    origin: string;
    resolverHostName: string;
    resolverDisplayName: string;
    surfaceEntry: SelfSurfaceEntry | null;
}): NamespaceProviderBoot;
export declare function injectNamespaceProviderShell(html: string, boot: NamespaceProviderBoot): string;
export declare function resolveNamespaceSurfaceSpec(input: {
    namespace: string;
    route: string;
    surfaceEntry: SelfSurfaceEntry | null;
}): Record<string, unknown>;
