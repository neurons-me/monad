export interface SemanticSeed {
    path: string;
    data: unknown;
    operator?: string;
}
export interface PollsStudioCategoryDefinition {
    slug: string;
    label: string;
    description: string;
    kind: string;
    order: number;
}
export declare const ROOT_SCHEMA_SEEDS: SemanticSeed[];
export declare const POLLS_STUDIO_DEFAULT_CATEGORIES: PollsStudioCategoryDefinition[];
export declare function buildPollsStudioCategorySeeds(basePath?: string): SemanticSeed[];
export declare function buildClaimSemanticSeeds(input: {
    namespace: string;
    username: string;
    passwordHash: string;
}): SemanticSeed[];
