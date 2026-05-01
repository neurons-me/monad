import type express from "express";
import { type ObserverRelation } from "./namespace.js";
export type MeOperationKind = "read" | "write" | "claim" | "open";
export interface NormalizedMeTarget {
    host: string;
    namespace: string;
    operation: MeOperationKind;
    path: string;
    nrp: string;
    relation: ObserverRelation;
}
export declare function buildMeTargetNrp(namespace: string, operation: MeOperationKind, path: string, relation: ObserverRelation): string;
export declare function normalizeHttpRequestToMeTarget(req: express.Request): NormalizedMeTarget;
