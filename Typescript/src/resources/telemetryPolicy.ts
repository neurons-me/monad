/**
 * telemetryPolicy.ts -- how often automatic telemetry may write into the chain.
 *
 * Every memory appended to the kernel stays in the hash chain and in the snapshot forever, and is serialized in full on
 * every save. Telemetry is written by timers and by every request -- including automatic probes (netget's /__surface
 * check, a browser tab polling /gateway-identity) -- so its volume is set by clocks, not by people. On 2026-11-12/13
 * the per-request entries alone were 88 % of a production snapshot's bytes, after an earlier cleanup and with slower
 * intervals configured in env.json.
 *
 * Policy, enforced in code so it holds after every restart whatever the environment says:
 *   - no request writes its own memory: requests are counted in RAM and written as ONE signed aggregate per window;
 *   - windows and host samples default to 10 minutes, and no configuration can bring them below 1 minute;
 *   - an aggregate's keys (hosts, identities, operations) are capped per window, so request headers chosen by a client
 *     cannot grow a single memory without bound.
 */

export const TELEMETRY_DEFAULT_INTERVAL_MS = 600_000;
export const TELEMETRY_MIN_INTERVAL_MS = 60_000;

/** Distinct keys kept per aggregate map in one window; the rest are counted under OVERFLOW_KEY. */
export const TELEMETRY_MAX_KEYS = 32;
export const TELEMETRY_OVERFLOW_KEY = "_other";

/**
 * The interval to use for a telemetry timer: the configured value when it is a finite number, the default otherwise,
 * never below the minimum.
 */
export function resolveTelemetryIntervalMs(configured: unknown): number {
  const raw = typeof configured === "string" ? configured.trim() : configured;
  const n = raw === "" || raw === undefined || raw === null ? NaN : Number(raw);
  const value = Number.isFinite(n) ? n : TELEMETRY_DEFAULT_INTERVAL_MS;
  return Math.max(TELEMETRY_MIN_INTERVAL_MS, value);
}
