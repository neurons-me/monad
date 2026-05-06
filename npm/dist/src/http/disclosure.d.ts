import type express from "express";
export type DisclosureStatus = "ok" | "error" | "pending";
export interface DisclosureOrigin {
    monad_id: string;
    namespace: string;
    endpoint: string;
    name?: string;
}
export interface DisclosureFrame {
    status: DisclosureStatus;
    path: string;
    origin: DisclosureOrigin;
}
export declare function isDisclosureEnabled(): boolean;
export declare function buildDisclosureOrigin(): DisclosureOrigin;
export declare function applyDisclosureFrame(body: Record<string, unknown>, path: string): Record<string, unknown>;
export declare function createDisclosureMiddleware(): express.RequestHandler;
