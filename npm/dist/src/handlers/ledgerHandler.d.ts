import type express from "express";
import type { NamespaceProviderBoot } from "../http/provider.js";
export type LedgerHandlerConfig = {
    buildRequestProviderBoot: (req: express.Request, namespace: string) => NamespaceProviderBoot | null;
    onBridgeRequest: express.RequestHandler;
};
export type LedgerHandlers = {
    root: express.RequestHandler;
    rootRead: express.RequestHandler;
    blocks: express.RequestHandler;
    blockchain: express.RequestHandler;
    atPath: express.RequestHandler;
    catchAll: express.RequestHandler;
};
export declare function createLedgerHandlers(config: LedgerHandlerConfig): LedgerHandlers;
