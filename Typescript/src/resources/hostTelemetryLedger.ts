/**
 * @module HostTelemetryLedger
 * @memberof module:monad.resources
 *
 * Materialises this host's own hardware telemetry (CPU/RAM/storage — the
 * same numbers `surfaceTelemetry.ts`/`selfMapping.ts` compute for the
 * `/__bootstrap`/`/__surface` HTTP response) into the kernel-backed
 * semantic memory tree, on a timer, so it becomes part of the queryable
 * `.me` knowledge graph instead of only existing as an ephemeral HTTP
 * response that vanishes the moment nobody's polling.
 *
 * Written under the root namespace (`getRootNamespace()`), sibling to
 * `surface.usage.*` (see `usageLedger.ts`) — `surface.host.cpu`,
 * `surface.host.memory`, `surface.host.storage`. Once written, these are
 * resolvable through the exact same generic `me://`/REST path-resolution
 * machinery every other semantic-memory path already uses — no separate
 * read-side registration needed (confirmed: `namespaceToKernelPrefix()`
 * resolves the root namespace to kernel prefix `""`, and
 * `listSemanticMemoriesByNamespace`/`readSemanticValueForNamespace` scan
 * `getKernel().memories` by that prefix same as `surface.usage.*` already
 * does).
 *
 * Deliberately unsigned, unlike `usageLedger.ts`'s resource-accounting
 * entries — those feed billing/"resource crypto" and need provenance;
 * this is informational host self-reporting, same trust tier as
 * `claimSemantics.ts`'s plain seed writes.
 *
 * ## Integration
 *
 * ```typescript
 * import { defaultHostTelemetryLedger } from './resources/hostTelemetryLedger.js';
 * defaultHostTelemetryLedger.start();
 * ```
 *
 * @see {@link module:monad.http.surfaceTelemetry}
 * @see {@link module:monad.resources.ResourceUsageLedger}
 */

import { appendSemanticMemory } from '../claim/memoryStore.js';
import { getRootNamespace } from '../kernel/manager.js';
import { TELEMETRY_DEFAULT_INTERVAL_MS, resolveTelemetryIntervalMs } from './telemetryPolicy.js';
import { getSurfaceTelemetrySnapshot } from '../http/surfaceTelemetry.js';
import { measureLiveCpuCores, measureLiveRamGb, measureLiveStorageGb } from '../http/selfMapping.js';

export class HostTelemetryLedger {
  private _namespace: string | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;

  private _resolveNamespace(): string {
    if (!this._namespace) {
      try {
        this._namespace = getRootNamespace();
      } catch {
        this._namespace = 'unknown';
      }
    }
    return this._namespace;
  }

  /**
   * Starts sampling and writing host telemetry.
   * Subsequent calls while already running are silently ignored.
   *
   * @param intervalMs - Sample interval in milliseconds. Default: 10 minutes; never below 1 minute
   *   (telemetryPolicy.ts): every sample appends three memories to the chain.
   */
  start(intervalMs: number = TELEMETRY_DEFAULT_INTERVAL_MS): this {
    if (this._timer) return this;

    const interval = resolveTelemetryIntervalMs(intervalMs);
    this.sampleNow();
    this._timer = setInterval(() => this.sampleNow(), interval);
    this._timer.unref?.();

    return this;
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get isRunning(): boolean {
    return this._timer !== null;
  }

  /** Samples current host telemetry and writes it into the kernel now, outside the timer. */
  sampleNow(): void {
    const namespace = this._resolveNamespace();
    const snapshot = getSurfaceTelemetrySnapshot();
    const timestamp = Date.now();

    try {
      appendSemanticMemory({
        namespace,
        path: 'surface.host.cpu',
        data: {
          cores: measureLiveCpuCores(),
          usageRatio: snapshot.usage.cpu,
          timestamp,
        },
      });

      appendSemanticMemory({
        namespace,
        path: 'surface.host.memory',
        data: {
          totalGb: measureLiveRamGb(),
          usageRatio: snapshot.usage.memory,
          source: snapshot.memoryDetail.source,
          usedGb: snapshot.memoryDetail.usedGb,
          reclaimableGb: snapshot.memoryDetail.reclaimableGb,
          breakdown: snapshot.memoryDetail.breakdown ?? null,
          timestamp,
        },
      });

      appendSemanticMemory({
        namespace,
        path: 'surface.host.storage',
        data: {
          totalGb: measureLiveStorageGb(),
          usageRatio: snapshot.usage.storage,
          timestamp,
        },
      });
    } catch {
      // Never let a telemetry write crash the daemon — same posture as
      // usageLedger.ts's per-entry try/catch.
    }
  }
}

export const defaultHostTelemetryLedger = new HostTelemetryLedger();
