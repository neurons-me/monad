export interface NamespaceIdentityParts {
    host: string;
    username: string;
    effective: string;
}
export declare const DEFAULT_LOCAL_NAMESPACE_ROOT = "monad.local";
export declare function normalizeNamespaceIdentity(input: unknown): string;
export declare function normalizeNamespaceConstant(input: unknown): string;
export declare function normalizeNamespaceRootName(input: unknown): string;
export declare function isProjectableNamespaceRoot(input: unknown): boolean;
export declare function composeProjectedNamespace(username: string, rootNamespace: string): string;
export declare function parseNamespaceIdentityParts(input: unknown): NamespaceIdentityParts;
