import type express from "express";
import { type SelfNodeConfig } from "../http/selfMapping.js";
export type BridgeHandlerConfig = {
    hostname: string;
    port: string | number;
    selfNodeConfig: SelfNodeConfig | null;
};
export declare function createBridgeHandler(config: BridgeHandlerConfig): express.RequestHandler;
