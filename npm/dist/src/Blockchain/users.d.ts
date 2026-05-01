export type UserRow = {
    username: string;
    identityHash: string;
    publicKey: string;
    createdAt: number;
    updatedAt: number;
};
export type ClaimUserResult = {
    ok: true;
    user: UserRow;
} | {
    ok: false;
    error: "USERNAME_TAKEN" | "USERNAME_REQUIRED" | "IDENTITY_HASH_REQUIRED" | "PUBLIC_KEY_REQUIRED";
};
export declare function getAllUsers(): UserRow[];
export declare function getUsersForRootNamespace(rootNamespaceInput: string): UserRow[];
export declare function getUser(username: string): UserRow | undefined;
export declare function claimUser(username: string, identityHash: string, publicKey: string): ClaimUserResult;
export declare function countBlocksForUser(identityHash: string): number;
