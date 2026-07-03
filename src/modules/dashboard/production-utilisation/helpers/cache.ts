import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import LRU from 'lru-cache';
import { createHash } from 'crypto';

/**
 * Phase 25 Plan 04 — In-memory LRU cache for utilisation aggregations (D-05).
 *
 * Bounds:
 *   - max: 500 entries (key set across all workspaces × scopes × filters)
 *   - maxAge: 5 minutes (lru-cache v5 API — Pitfall 6: NOT `ttl`, which is v7+)
 *
 * Invalidation:
 *   - `production_log.changed` → reset (Phase 25 Plan 03 emits on
 *     ProductionLogService write paths)
 *   - `downtime.changed` → reset (DowntimeService already emits — verified
 *     in downtime.service.ts:556-560)
 *
 * Per-workspace tagging would require a secondary index over keys; v1 takes
 * the simpler path of a full `reset()` on any write event. Trade-off: a busy
 * workspace can incidentally invalidate cache for other workspaces. This is
 * acceptable for v1 because (a) we are single-pod and (b) the 5-min worst
 * case staleness window already implies tolerance for cache misses; D-05
 * permits this design.
 *
 * Cache key derivation (`buildKey`):
 *   sha1(JSON({ p: prefix, ws, scope: scopeFingerprint, f: normalisedFilters }))
 *
 * `scopeFingerprint` MUST be present (Pitfall 7 — without it, an admin's
 * cached result could leak to a scoped manager and vice versa). The scope
 * helper (`extractScope`) supplies 'admin' for unscoped users and a sorted-
 * hex digest for scoped users.
 */
@Injectable()
export class UtilisationCacheService {
  private readonly logger = new Logger(UtilisationCacheService.name);
  private readonly cache: LRU<string, unknown> = new LRU<string, unknown>({
    max: 500,
    maxAge: 5 * 60 * 1000,
  });

  buildKey(
    prefix: 'kpi' | 'trend' | 'heatmap' | 'export',
    ctx: {
      workspaceId: string;
      scopeFingerprint: string;
      filters: Record<string, unknown>;
    },
  ): string {
    const normalised = JSON.stringify({
      p: prefix,
      ws: ctx.workspaceId,
      scope: ctx.scopeFingerprint,
      f: this.normaliseFilters(ctx.filters),
    });
    return createHash('sha1').update(normalised).digest('hex');
  }

  private normaliseFilters(
    f: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(f).sort()) {
      const v = (f as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        out[k] = [...v].map((x) => String(x)).sort();
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
  }

  invalidateByWorkspace(wsId: string): void {
    // v1 design: full reset on any workspace event (see header comment).
    this.cache.reset();
    this.logger.debug(`Cache reset on event for ws=${wsId}`);
  }

  @OnEvent('production_log.changed')
  onProductionLogChanged(payload: {
    workspaceId: string;
    machineId: string | null;
  }): void {
    this.invalidateByWorkspace(payload.workspaceId);
  }

  @OnEvent('downtime.changed')
  onDowntimeChanged(payload: {
    workspaceId: string;
    machineId: string;
  }): void {
    this.invalidateByWorkspace(payload.workspaceId);
  }
}
