import express from "express";
import { type MonadBootstrapResult, type MonadOptions } from "./bootstrap.js";
export type MonadApp = express.Express & {
    monad: MonadBootstrapResult;
};
export declare function createMonadApp(options?: MonadOptions): Promise<MonadApp>;
