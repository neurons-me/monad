import type express from "express";
export type ResolvedNamespacePath = {
    namespace: string;
    path: string;
    value?: unknown;
    found: boolean;
};
export declare function resolveNamespacePathValue(namespaceInput: string, dotPathInput: string): Promise<ResolvedNamespacePath>;
export declare function createPathResolverHandler(): (req: express.Request, res: express.Response) => Promise<express.Response<any, Record<string, any>>>;
