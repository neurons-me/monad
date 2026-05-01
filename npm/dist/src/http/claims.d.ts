import express from "express";
export declare function readOpenedClaimProfile(namespace: string): {
    profile: {
        username: string;
        name: string;
        email: string;
        phone: string;
    };
    claimedAt: number | null;
};
export declare const claimRequestHandler: express.RequestHandler;
export declare const openRequestHandler: express.RequestHandler;
export declare function createClaimsRouter(): express.Router;
