import { type MeDnsProjectionFailureReason } from "this.me";
export interface ResolveHostToMeUriOptions {
    knownSpaces?: readonly string[];
}
export type ResolveHostToMeUriResult = {
    ok: true;
    kind: "space";
    host: string;
    namespace: string;
    space: string;
    canonical: null;
    knownSpaces: string[];
} | {
    ok: true;
    kind: "namespace";
    host: string;
    namespace: string;
    handle: string;
    space: string;
    canonical: string;
    knownSpaces: string[];
} | {
    ok: false;
    host: string;
    reason: MeDnsProjectionFailureReason;
    matchedSpace: string | null;
    prefixLabels: string[];
    knownSpaces: string[];
};
export declare function resolveHostToMeUri(rawHost: string, options?: ResolveHostToMeUriOptions): ResolveHostToMeUriResult;
export declare function resolveHostToCanonicalNamespace(rawHost: string, options?: ResolveHostToMeUriOptions): string | null;
