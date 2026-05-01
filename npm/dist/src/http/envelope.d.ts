import type { NormalizedMeTarget } from "./meTarget.js";
type EnvelopeShape = Record<string, unknown>;
export declare function createEnvelope(target: NormalizedMeTarget, body?: EnvelopeShape): EnvelopeShape;
export declare function createErrorEnvelope(target: NormalizedMeTarget, body?: EnvelopeShape): EnvelopeShape;
export {};
