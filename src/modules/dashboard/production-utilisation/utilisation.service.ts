/**
 * Phase 25 Plan 06 — UtilisationService.
 *
 * Workhorse of the Production Utilisation Dashboard. Composes a complete
 * `KpiResponse` (D-08) covering all six locked KPI cards:
 *   1. Today output (split by metric — Pitfall 5)
 *   2. Week output  (Mon-Sun in workspace tz)
 *   3. Month output (1st-last of month in workspace tz)
 *   4. Uptime % vs target (current month, with delta vs prior month + R/A/G band)
 *   5. Top 3 machines (current month, by output sum)
 *   6. Top 3 downtime reasons (current month, by sum durationMinutes)
 *
 * Key composition:
 *   - One `$facet` over ProductionLog covers cards 1-3 + 5.
 *   - One `$facet` over DowntimeEntry + ShiftClipper covers cards 4 + 6.
 *   - LRU cache fronts the entire compose — keyed on workspace + scope
 *     fingerprint + filters (Pitfall 7).
 *   - Defence-in-depth scope assertion via assertWorkspaceMachines (D-16).
 *
 * Boundaries computed in workspace tz via Intl.DateTimeFormat (no dayjs in
 * backend). ISO week (Mon-Sun) per D-08.
 *
 * Pitfall 9: every aggregation carries `maxTimeMS:25000 + allowDiskUse:true`.
 * Pitfall 1: ProductionLog.date is `String 'YYYY-MM-DD'` — pipeline builders
 *   filter accordingly.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { UtilisationCacheService } from './helpers/cache';
import { ShiftClipperService } from './aggregations/shift-clipper';
import {
  buildKpiOutputPipeline,
  buildTrendOutputPipeline,
  buildHeatmapOutputPipeline,
  buildExportOutputPipeline,
  selectGranularity,
  KpiOutputBoundaries,
} from './aggregations/output.aggregations';
import {
  buildKpiDowntimePipeline,
  buildLastMonthDowntimePipeline,
  buildTrendDowntimePipeline,
  buildHeatmapDowntimePipeline,
  buildExportTopReasonPipeline,
  KpiDowntimeBoundaries,
} from './aggregations/downtime.aggregations';
import { assertWorkspaceMachines } from './helpers/scope';
import {
  rangeToFilters,
  assertRangeWithin365Days,
  computeDefaultRangeYmd,
} from './helpers/tz-range';
import type {
  KpiResponse,
  ByMetricSums,
  PrimaryMetric,
  UptimeBand,
  TrendResponse,
  TrendPoint,
  TrendGranularity,
  HeatmapResponse,
  HeatmapCell,
  UtilisationExportRow,
} from './types';

export interface UtilCtx {
  workspaceId: string;
  scopedMachineIds?: Types.ObjectId[];
  scopeFingerprint: string;
  tz: string;
  requestedMachineIds?: string[];
  requestedShiftIds?: string[];
  requestedLocationIds?: string[];
}

@Injectable()
export class UtilisationService {
  private readonly logger = new Logger(UtilisationService.name);

  constructor(
    @InjectModel('ProductionLog') private readonly productionLogModel: Model<any>,
    @InjectModel('DowntimeEntry') private readonly downtimeModel: Model<any>,
    @InjectModel('Machine') private readonly machineModel: Model<any>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('Location') private readonly locationModel: Model<any>,
    private readonly cache: UtilisationCacheService,
    private readonly shiftClipper: ShiftClipperService,
  ) {}

  /**
   * Compose the full KPI response for the active workspace + scope + filters.
   * Cache-aware (5-min LRU). Returns immediately on cache hit.
   */
  async getKpis(
    ctx: UtilCtx,
    customFromYmd?: string,
    customToYmd?: string,
  ): Promise<KpiResponse> {
    const useCustomRange = !!(customFromYmd && customToYmd);
    if (useCustomRange) {
      // WR-04: enforce 365-day cap when caller supplies an explicit range.
      assertRangeWithin365Days(customFromYmd!, customToYmd!);
    }
    const cacheKey = this.cache.buildKey('kpi', {
      workspaceId: ctx.workspaceId,
      scopeFingerprint: ctx.scopeFingerprint,
      filters: {
        machineIds: ctx.requestedMachineIds,
        locationIds: ctx.requestedLocationIds,
        shiftIds: ctx.requestedShiftIds,
        customFromYmd: useCustomRange ? customFromYmd : undefined,
        customToYmd: useCustomRange ? customToYmd : undefined,
      },
    });
    const cached = this.cache.get<KpiResponse>(cacheKey);
    if (cached) return cached;

    // D-16 defence-in-depth: re-verify any client-supplied machineIds
    // belong to this workspace AND lie inside the caller's scope.
    await assertWorkspaceMachines(
      this.machineModel,
      ctx.requestedMachineIds,
      ctx.workspaceId,
      ctx.scopedMachineIds,
    );

    const wsObj = new Types.ObjectId(ctx.workspaceId);
    const tz = ctx.tz;

    // CR-01 fix: resolve locationIds → machine set, intersect with scope.
    const locationMachineIds = await this.resolveMachineIdsForLocations(
      wsObj,
      ctx.requestedLocationIds,
    );

    // ---- Boundary computation (workspace tz) ----
    const todayYmd = formatYmdInTz(new Date(), tz);
    const { weekFromYmd, weekToYmd } = isoWeekRangeYmd(todayYmd);
    const { monthFromYmd, monthToYmd } = monthRangeYmd(todayYmd);
    const { monthFromYmd: lastMonthFromYmd, monthToYmd: lastMonthToYmd } =
      previousMonthRangeYmd(todayYmd);

    // WR-04: when caller supplies from/to, those become the "primary range"
    // for cards 1-6 (output total + uptime% + top machines + top reasons).
    // Default behaviour (no from/to) keeps today/week/month windows.
    const primaryFromYmd = useCustomRange ? customFromYmd! : monthFromYmd;
    const primaryToYmd = useCustomRange ? customToYmd! : monthToYmd;

    const primaryStartUtc = parseLocalStartOfDayUtc(primaryFromYmd, tz);
    const primaryEndUtc = parseLocalEndOfDayUtc(primaryToYmd, tz);
    const lastMonthStartUtc = parseLocalStartOfDayUtc(lastMonthFromYmd, tz);
    const lastMonthEndUtc = parseLocalEndOfDayUtc(lastMonthToYmd, tz);

    const requestedMachineObjs = ctx.requestedMachineIds?.map(
      (id) => new Types.ObjectId(id),
    );
    const shiftObjs = ctx.requestedShiftIds?.map(
      (id) => new Types.ObjectId(id),
    );

    // CR-01 fix: when locationIds supplied, the effective scope is the
    // intersection of (requested machines OR scope) with the location-resolved
    // machine set. Pre-compute the effective machine set for all $match stages.
    const effectiveMachineObjs = this.intersectMachineSets(
      requestedMachineObjs,
      ctx.scopedMachineIds,
      locationMachineIds,
    );
    // If the intersection collapsed to an empty list (location filter excludes
    // everything), short-circuit with an empty response so we don't issue
    // unscoped pipelines.
    const intersectionIsEmpty = effectiveMachineObjs?.length === 0;

    const outBoundaries: KpiOutputBoundaries = {
      todayYmd,
      weekFromYmd,
      weekToYmd,
      // Cards 1-3 (today/week/month) are split-by-metric over today/week/month
      // unless caller supplied a custom range — then collapse them all to the
      // primary range so the three cards reflect the same window.
      monthFromYmd: primaryFromYmd,
      monthToYmd: primaryToYmd,
    };
    const downBoundaries: KpiDowntimeBoundaries = {
      monthStartUtc: primaryStartUtc,
      monthEndUtc: primaryEndUtc,
      lastMonthStartUtc,
      lastMonthEndUtc,
    };

    // ---- ProductionLog facet (cards 1-3 + 5) ----
    const outputPipeline = buildKpiOutputPipeline({
      workspaceId: wsObj,
      // CR-01: pass the intersection as the effective machine set.
      scopedMachineIds: effectiveMachineObjs,
      requestedMachineIds: undefined,
      shiftIds: shiftObjs,
      boundaries: outBoundaries,
    });
    const outFacetArr = intersectionIsEmpty
      ? [{}]
      : await this.productionLogModel.aggregate(outputPipeline, {
          maxTimeMS: 25000,
          allowDiskUse: true,
        });
    const outFacet = outFacetArr[0] ?? {};

    // ---- DowntimeEntry facet (primary range — card 6 + uptime numerator) ----
    const downPipeline = buildKpiDowntimePipeline({
      workspaceId: wsObj,
      scopedMachineIds: effectiveMachineObjs,
      requestedMachineIds: undefined,
      boundaries: downBoundaries,
    });
    const downFacetArr = intersectionIsEmpty
      ? [{}]
      : await this.downtimeModel.aggregate(downPipeline, {
          maxTimeMS: 25000,
          allowDiskUse: true,
        });
    const downFacet = downFacetArr[0] ?? {};

    // ---- Last-month downtime raw entries for delta-vs-prior-month ----
    const lastMonthEntries = intersectionIsEmpty
      ? []
      : await this.downtimeModel.aggregate(
          buildLastMonthDowntimePipeline({
            workspaceId: wsObj,
            scopedMachineIds: effectiveMachineObjs,
            requestedMachineIds: undefined,
            boundaries: downBoundaries,
          }),
          { maxTimeMS: 25000, allowDiskUse: true },
        );

    // ---- Resolve scope-effective machine list for ShiftClipper ----
    const machineList: Types.ObjectId[] =
      effectiveMachineObjs ??
      (await this.allWorkspaceMachineIds(ctx.workspaceId));

    // ---- ShiftClipper passes for uptime numerator/denominator ----
    const primaryRange = { fromYmd: primaryFromYmd, toYmd: primaryToYmd };
    const lastMonthRange = {
      fromYmd: lastMonthFromYmd,
      toYmd: lastMonthToYmd,
    };
    const schedThisRange =
      await this.shiftClipper.scheduledMinutesByMachine(
        ctx.workspaceId,
        machineList,
        primaryRange,
        tz,
        ctx.requestedShiftIds,
      );
    const schedLastMonth =
      await this.shiftClipper.scheduledMinutesByMachine(
        ctx.workspaceId,
        machineList,
        lastMonthRange,
        tz,
        ctx.requestedShiftIds,
      );
    const downThisRangeByMachine =
      await this.shiftClipper.clipDowntimeToShifts(
        ctx.workspaceId,
        machineList,
        (downFacet.rawEntries ?? []) as any[],
        primaryRange,
        tz,
        ctx.requestedShiftIds,
      );
    const downLastMonthByMachine =
      await this.shiftClipper.clipDowntimeToShifts(
        ctx.workspaceId,
        machineList,
        lastMonthEntries as any[],
        lastMonthRange,
        tz,
        ctx.requestedShiftIds,
      );

    const sumValues = (m: Map<string, number>) =>
      Array.from(m.values()).reduce((a, b) => a + b, 0);
    const schedTotal = sumValues(schedThisRange);
    const downTotal = sumValues(downThisRangeByMachine);
    const schedLastTotal = sumValues(schedLastMonth);
    const downLastTotal = sumValues(downLastMonthByMachine);

    // D-06 uptime formula. Round to 2dp; clamp negative to 0.
    const actualPct =
      schedTotal > 0
        ? Math.max(
            0,
            Math.round(
              ((schedTotal - downTotal) / schedTotal) * 100 * 100,
            ) / 100,
          )
        : 0;
    const lastPct =
      schedLastTotal > 0
        ? Math.max(
            0,
            Math.round(
              ((schedLastTotal - downLastTotal) / schedLastTotal) *
                100 *
                100,
            ) / 100,
          )
        : 0;
    const targetPct = await this.resolveWorkspaceTargetPct(ctx.workspaceId);

    // ---- Top machines: hydrate names ----
    const topMachineRaw = (outFacet.topMachines ?? []) as Array<{
      _id: { machineId: any; metric: string };
      sum: number;
    }>;
    const topMachineIds = topMachineRaw.map(
      (r) => new Types.ObjectId(String(r._id.machineId)),
    );
    const machineNames = topMachineIds.length
      ? await this.machineModel
          .find(
            { _id: { $in: topMachineIds }, workspaceId: wsObj },
            { name: 1 },
          )
          .lean()
      : [];
    const nameById = new Map(
      machineNames.map((m: any) => [String(m._id), m.name as string]),
    );

    const response: KpiResponse = {
      todayOutput: this.bucketsToByMetric(outFacet.todayByMetric ?? []),
      weekOutput: this.bucketsToByMetric(outFacet.weekByMetric ?? []),
      monthOutput: this.bucketsToByMetric(outFacet.monthByMetric ?? []),
      uptime: {
        actualPct,
        targetPct,
        deltaVsPriorMonthPct:
          Math.round((actualPct - lastPct) * 100) / 100,
        band: this.computeBand(actualPct, targetPct),
      },
      topMachines: topMachineRaw.map((r) => ({
        machineId: String(r._id.machineId),
        machineName: nameById.get(String(r._id.machineId)) ?? '—',
        output: r.sum,
        metric: r._id.metric as PrimaryMetric,
      })),
      topReasons: ((downFacet.topReasons ?? []) as any[]).map((r) => ({
        reasonCodeKey: r._id.key,
        reasonLabel: r._id.label,
        downMinutes: r.downMin,
      })),
      filtersEcho: {
        // WR-04: echo the actual primary range used for the response so the UI
        // can re-label cards (e.g., "Output (custom range)" instead of "Today").
        from: primaryFromYmd,
        to: primaryToYmd,
        machineIds: ctx.requestedMachineIds ?? [],
        locationIds: ctx.requestedLocationIds ?? [],
        shiftIds: ctx.requestedShiftIds ?? [],
      },
    };

    this.cache.set(cacheKey, response);
    return response;
  }

  /**
   * CR-01 helper — resolve `requestedLocationIds` to the set of machine ids
   * that live in those locations within the workspace. Returns `undefined`
   * when no locations were requested (i.e., no constraint to apply).
   *
   * Validates that the requested location ids belong to the workspace by
   * filtering on `workspaceId`. Locations outside the workspace silently
   * contribute zero machines (defence-in-depth — cross-tenant probing returns
   * empty machine set rather than leaking results).
   */
  private async resolveMachineIdsForLocations(
    workspaceId: Types.ObjectId,
    locationIds?: string[],
  ): Promise<Types.ObjectId[] | undefined> {
    if (!locationIds || locationIds.length === 0) return undefined;
    const locObjs = locationIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (locObjs.length === 0) return [];
    const docs = await this.machineModel
      .find(
        {
          workspaceId,
          locationId: { $in: locObjs },
          isDeleted: false,
        },
        { _id: 1 },
      )
      .lean();
    return (docs as any[]).map((d) => d._id as Types.ObjectId);
  }

  /**
   * CR-01 helper — intersect any number of machine-id constraints. Each input
   * either constrains the set or is `undefined` (means "no constraint").
   * Returns:
   *   - `undefined` when ALL inputs are undefined (no machine-level filter).
   *   - The intersection (possibly empty array) when at least one constrains.
   */
  private intersectMachineSets(
    ...sets: Array<Types.ObjectId[] | undefined>
  ): Types.ObjectId[] | undefined {
    const nonNull = sets.filter(
      (s): s is Types.ObjectId[] => s !== undefined,
    );
    if (nonNull.length === 0) return undefined;
    const [first, ...rest] = nonNull;
    let acc = new Set(first.map((o) => o.toHexString()));
    for (const s of rest) {
      const next = new Set(s.map((o) => o.toHexString()));
      acc = new Set([...acc].filter((x) => next.has(x)));
      if (acc.size === 0) return [];
    }
    // Preserve ObjectId type by reusing the first set's instances when present.
    const byHex = new Map<string, Types.ObjectId>();
    for (const s of nonNull) {
      for (const o of s) byHex.set(o.toHexString(), o);
    }
    return Array.from(acc).map((hex) => byHex.get(hex)!);
  }

  /** Pitfall 5 — never collapse across metrics; always project the three
   *  buckets independently. Buckets are `{_id: 'stitches'|'pieces'|'hours', sum}`. */
  private bucketsToByMetric(
    buckets: Array<{ _id: string; sum: number }>,
  ): ByMetricSums {
    const out: ByMetricSums = { stitches: 0, pieces: 0, hours: 0 };
    for (const b of buckets) {
      if (b._id === 'stitches') out.stitches = b.sum;
      else if (b._id === 'pieces') out.pieces = b.sum;
      else if (b._id === 'hours') out.hours = b.sum;
    }
    return out;
  }

  /** D-07 default — workspace fallback to 85 if unset. Per-machine override
   *  not applied at the workspace-aggregate KPI card (single value, single
   *  band). Per-machine targets surface in the trend page (Plan 07). */
  private async resolveWorkspaceTargetPct(
    workspaceId: string,
  ): Promise<number> {
    const ws = await this.workspaceModel
      .findOne(
        { _id: new Types.ObjectId(workspaceId) },
        { productionUptimeTargetPct: 1 },
      )
      .lean();
    return (ws as any)?.productionUptimeTargetPct ?? 85;
  }

  /** D-07 R/A/G banding: actual >= target → green; >= target-10 → amber;
   *  else red. */
  private computeBand(actual: number, target: number): UptimeBand {
    if (actual >= target) return 'green';
    if (actual >= target - 10) return 'amber';
    return 'red';
  }

  private async allWorkspaceMachineIds(
    workspaceId: string,
  ): Promise<Types.ObjectId[]> {
    const docs = await this.machineModel
      .find(
        { workspaceId: new Types.ObjectId(workspaceId), isDeleted: false },
        { _id: 1 },
      )
      .lean();
    return docs.map((d: any) => d._id);
  }

  /** Convenience for the controller (Plan 09) — Workspace.timezone fallback
   *  to Asia/Kolkata if unset (matches phase 22/24 precedent). */
  async getWorkspaceTz(workspaceId: string): Promise<string> {
    const ws = await this.workspaceModel
      .findOne(
        { _id: new Types.ObjectId(workspaceId) },
        { timezone: 1 },
      )
      .lean();
    return (ws as any)?.timezone ?? 'Asia/Kolkata';
  }

  /**
   * Phase 25 Plan 07 — Per-machine trend (output line + uptime area).
   *
   * Granularity is auto-selected from the span (D-11, locked):
   *   <=31d → daily, 32-180d → weekly, >180d → monthly.
   *
   * For each period bucket we re-run the ShiftClipper (scheduled + clipped
   * downtime) so uptime% reflects bucket-local shift coverage. Bounded:
   * point count is at most 31 (daily) / 26 (weekly) / 12 (monthly), so the
   * per-period clipper iteration is safe (T-25-07-03).
   *
   * Defence-in-depth scope check (T-25-07-01): the single machineId path
   * param is asserted against workspace + scope BEFORE any DB I/O.
   * D-27 range guard (T-25-07-02) runs first.
   */
  async getTrend(
    ctx: UtilCtx,
    machineId: string,
    fromYmd?: string,
    toYmd?: string,
  ): Promise<TrendResponse> {
    const tz = ctx.tz;
    const range =
      fromYmd && toYmd
        ? { from: fromYmd, to: toYmd }
        : computeDefaultRangeYmd(tz, 30);

    // T-25-07-02: reject oversized range BEFORE DB.
    assertRangeWithin365Days(range.from, range.to);

    // T-25-07-01: defence-in-depth scope check.
    await assertWorkspaceMachines(
      this.machineModel,
      [machineId],
      ctx.workspaceId,
      ctx.scopedMachineIds,
    );

    const cacheKey = this.cache.buildKey('trend', {
      workspaceId: ctx.workspaceId,
      scopeFingerprint: ctx.scopeFingerprint,
      filters: {
        machineId,
        fromYmd: range.from,
        toYmd: range.to,
        shiftIds: ctx.requestedShiftIds,
      },
    });
    const cached = this.cache.get<TrendResponse>(cacheKey);
    if (cached) return cached;

    const wsObj = new Types.ObjectId(ctx.workspaceId);
    const machObj = new Types.ObjectId(machineId);
    const shiftObjs = ctx.requestedShiftIds?.map(
      (id) => new Types.ObjectId(id),
    );
    const filters = rangeToFilters(range.from, range.to, tz);

    // Inclusive day count for granularity selection.
    const spanDays =
      Math.round(
        (new Date(range.to + 'T00:00:00Z').getTime() -
          new Date(range.from + 'T00:00:00Z').getTime()) /
          86_400_000,
      ) + 1;
    const granularity: TrendGranularity = selectGranularity(spanDays);

    // ---- Output aggregation (one round-trip, grouped by period) ----
    const outputRows = await this.productionLogModel.aggregate(
      buildTrendOutputPipeline({
        workspaceId: wsObj,
        machineId: machObj,
        fromYmd: range.from,
        toYmd: range.to,
        granularity,
        shiftIds: shiftObjs,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );

    // ---- Downtime raw entries for the full window ----
    const downRows = await this.downtimeModel.aggregate(
      buildTrendDowntimePipeline({
        workspaceId: wsObj,
        machineId: machObj,
        fromUtc: filters.downtimeStartAtFilter.$gte,
        toUtc: filters.downtimeStartAtFilter.$lte,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );

    // ---- Per-period buckets ----
    const periods = enumeratePeriods(range.from, range.to, granularity, tz);
    const targetPct = await this.resolveMachineTargetPct(
      ctx.workspaceId,
      machineId,
    );

    // WR-01 fix: pre-fetch machine→shift map ONCE for the entire trend
    // request (single machine, but repeated per-period iteration would still
    // re-query without this).
    const machineShifts = await this.shiftClipper.resolveMachineShifts(
      ctx.workspaceId,
      [machObj],
      ctx.requestedShiftIds,
    );

    const machineKey = machObj.toHexString();
    const points: TrendPoint[] = [];
    for (const p of periods) {
      const periodRange = { fromYmd: p.fromYmd, toYmd: p.toYmd };
      const sched = this.shiftClipper.scheduledMinutesByMachineWithShifts(
        [machObj],
        periodRange,
        tz,
        machineShifts,
      );

      // WR-02 fix: use workspace-tz day boundaries (mirrors heatmap impl)
      // instead of bare UTC midnight, which dropped entries that fell inside
      // the local-day window but outside the UTC-day window.
      const periodStartUtc = parseLocalStartOfDayUtc(p.fromYmd, tz).getTime();
      const periodEndUtc = parseLocalEndOfDayUtc(p.toYmd, tz).getTime();
      const periodEntries = downRows.filter((r: any) => {
        const start = (r.startAt as Date).getTime();
        const end = r.endAt ? (r.endAt as Date).getTime() : Date.now();
        return start <= periodEndUtc && end >= periodStartUtc;
      });

      const down = this.shiftClipper.clipDowntimeToShiftsWithShifts(
        [machObj],
        periodEntries as any,
        periodRange,
        tz,
        machineShifts,
      );
      const schedTotal = sched.get(machineKey) ?? 0;
      const downTotal = down.get(machineKey) ?? 0;
      const uptimePct =
        schedTotal > 0
          ? Math.max(
              0,
              Math.round(
                ((schedTotal - downTotal) / schedTotal) * 100 * 100,
              ) / 100,
            )
          : 0;
      const outputRow = outputRows.find((o: any) => o._id === p.label);
      points.push({
        period: p.label,
        output: outputRow?.output ?? 0,
        uptimePct,
        targetPct,
      });
    }

    const response: TrendResponse = { granularity, points };
    this.cache.set(cacheKey, response);
    return response;
  }

  /** D-07 — per-machine override (machine.uptimeTargetPct) wins over the
   *  workspace default. Used by the trend page (Plan 12 web). */
  private async resolveMachineTargetPct(
    workspaceId: string,
    machineId: string,
  ): Promise<number> {
    const m = await this.machineModel
      .findOne(
        {
          _id: new Types.ObjectId(machineId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { uptimeTargetPct: 1 },
      )
      .lean();
    if ((m as any)?.uptimeTargetPct != null) return (m as any).uptimeTargetPct;
    return this.resolveWorkspaceTargetPct(workspaceId);
  }

  /**
   * Phase 25 Plan 08 — Per-location heatmap (D-12 + D-13).
   *
   * Returns one cell per (machine in location) × (day in selected month).
   * Each cell carries utilisationPct ((sched - down) / sched), output sum,
   * and clipped down minutes. Bound to a single calendar month so the grid
   * is at most ~31 columns × N machines (D-13 hard rule, enforced by DTO).
   *
   * Scope: machines list is filtered by workspaceId + locationId AND
   * intersected with ctx.scopedMachineIds before any aggregation runs
   * (T-25-08-01 mitigation, defence-in-depth on top of ResourceScopeGuard).
   *
   * Pitfall 9: every aggregation carries maxTimeMS:25000 + allowDiskUse:true.
   */
  async getHeatmap(
    ctx: UtilCtx,
    locationId: string,
    monthYyyyMm: string,
  ): Promise<HeatmapResponse> {
    const tz = ctx.tz;
    const monthFromYmd = `${monthYyyyMm}-01`;
    const [y, m] = monthYyyyMm.split('-').map(Number);
    // Day 0 of next month = last day of this month (UTC-safe rollover).
    const monthToYmd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const monthStartUtc = parseLocalStartOfDayUtc(monthFromYmd, tz);
    const monthEndUtc = parseLocalEndOfDayUtc(monthToYmd, tz);

    const cacheKey = this.cache.buildKey('heatmap', {
      workspaceId: ctx.workspaceId,
      scopeFingerprint: ctx.scopeFingerprint,
      filters: {
        locationId,
        month: monthYyyyMm,
        shiftIds: ctx.requestedShiftIds,
      },
    });
    const cached = this.cache.get<HeatmapResponse>(cacheKey);
    if (cached) return cached;

    const wsObj = new Types.ObjectId(ctx.workspaceId);
    const locObj = new Types.ObjectId(locationId);

    // Resolve machines in location ∩ scope (T-25-08-01).
    const machineFilter: Record<string, unknown> = {
      workspaceId: wsObj,
      locationId: locObj,
      isDeleted: false,
    };
    if (ctx.scopedMachineIds && ctx.scopedMachineIds.length > 0) {
      machineFilter._id = { $in: ctx.scopedMachineIds };
    }
    const machines = await this.machineModel
      .find(machineFilter, {
        _id: 1,
        name: 1,
        machineCode: 1,
        primaryMetric: 1,
      })
      .lean();
    const days = enumerateDays(monthFromYmd, monthToYmd);

    if (machines.length === 0) {
      const empty: HeatmapResponse = {
        month: monthYyyyMm,
        locationId,
        cells: [],
        machines: [],
        days,
      };
      this.cache.set(cacheKey, empty);
      return empty;
    }

    const machineIds: Types.ObjectId[] = machines.map((mm: any) => mm._id);
    const shiftObjs = ctx.requestedShiftIds?.map(
      (id) => new Types.ObjectId(id),
    );

    // WR-01 fix: pre-fetch machine→shift map ONCE for the entire heatmap
    // render; reused across every (machine, day) iteration below.
    const machineShifts = await this.shiftClipper.resolveMachineShifts(
      ctx.workspaceId,
      machineIds,
      ctx.requestedShiftIds,
    );

    // Output per (machine, date).
    const outRows = await this.productionLogModel.aggregate(
      buildHeatmapOutputPipeline({
        workspaceId: wsObj,
        machineIds,
        monthFromYmd,
        monthToYmd,
        shiftIds: shiftObjs,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );
    const outputByKey = new Map<string, number>();
    for (const r of outRows) {
      outputByKey.set(
        `${String(r._id.machineId)}|${r._id.date}`,
        r.output,
      );
    }

    // Raw downtime entries within month (single round-trip).
    const downRows = await this.downtimeModel.aggregate(
      buildHeatmapDowntimePipeline({
        workspaceId: wsObj,
        machineIds,
        monthStartUtc,
        monthEndUtc,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );

    const cells: HeatmapCell[] = [];
    for (const mm of machines as any[]) {
      const machineKey = (mm._id as Types.ObjectId).toHexString();
      // CR-02 fix (heatmap): each machine has ONE primaryMetric snapshot,
      // so per-cell sum cannot mix metric units. Surface the metric on the
      // cell so the UI can render unit-correct labels (e.g. "12k stitches"
      // vs "85 pieces") and never present a unit-incompatible sum.
      const primaryMetric = (mm.primaryMetric as PrimaryMetric) ?? 'pieces';
      for (const day of days) {
        const dayRange = { fromYmd: day, toYmd: day };
        const sched = this.shiftClipper.scheduledMinutesByMachineWithShifts(
          [mm._id],
          dayRange,
          tz,
          machineShifts,
        );
        // Filter raw entries that overlap this local-day window.
        const dayStartUtc = parseLocalStartOfDayUtc(day, tz).getTime();
        const dayEndUtc = parseLocalEndOfDayUtc(day, tz).getTime();
        const dayEntries = downRows.filter((r: any) => {
          if (String(r.machineId) !== machineKey) return false;
          const start = (r.startAt as Date).getTime();
          const end = r.endAt
            ? (r.endAt as Date).getTime()
            : Date.now();
          return start <= dayEndUtc && end >= dayStartUtc;
        });
        const down = this.shiftClipper.clipDowntimeToShiftsWithShifts(
          [mm._id],
          dayEntries as any,
          dayRange,
          tz,
          machineShifts,
        );
        const schedTotal = sched.get(machineKey) ?? 0;
        const downTotal = down.get(machineKey) ?? 0;
        const utilisationPct =
          schedTotal > 0
            ? Math.max(
                0,
                Math.round(
                  ((schedTotal - downTotal) / schedTotal) * 100,
                ),
              )
            : 0;
        cells.push({
          machineId: machineKey,
          machineName: mm.name,
          date: day,
          utilisationPct,
          output: outputByKey.get(`${machineKey}|${day}`) ?? 0,
          outputMetric: primaryMetric,
          downMinutes: downTotal,
        });
      }
    }

    const response: HeatmapResponse = {
      month: monthYyyyMm,
      locationId,
      cells,
      machines: (machines as any[]).map((mm: any) => ({
        id: String(mm._id),
        name: mm.name,
      })),
      days,
    };
    this.cache.set(cacheKey, response);
    return response;
  }

  /**
   * Phase 25 Plan 08 — Flat per-machine export rows for F-14 export pipeline.
   *
   * Consumed by web ExportButton → ExportModal → generatePdf/generateExcel
   * (Plan 10/12). Server re-derives ResourceScope from ctx (D-20) — never
   * trusts client filter list as the scope authority.
   *
   * Pitfall 9: maxTimeMS + allowDiskUse on every aggregation.
   * D-27 range guard (T-25-08-04) runs first.
   */
  async getExportRows(
    ctx: UtilCtx,
    fromYmd?: string,
    toYmd?: string,
  ): Promise<UtilisationExportRow[]> {
    const tz = ctx.tz;
    const range =
      fromYmd && toYmd
        ? { from: fromYmd, to: toYmd }
        : computeDefaultRangeYmd(tz, 30);

    // T-25-08-04: reject oversized range BEFORE DB.
    assertRangeWithin365Days(range.from, range.to);

    // T-25-08-02: defence-in-depth scope check.
    await assertWorkspaceMachines(
      this.machineModel,
      ctx.requestedMachineIds,
      ctx.workspaceId,
      ctx.scopedMachineIds,
    );

    const cacheKey = this.cache.buildKey('export', {
      workspaceId: ctx.workspaceId,
      scopeFingerprint: ctx.scopeFingerprint,
      filters: {
        fromYmd: range.from,
        toYmd: range.to,
        machineIds: ctx.requestedMachineIds,
        locationIds: ctx.requestedLocationIds,
        shiftIds: ctx.requestedShiftIds,
      },
    });
    const cached = this.cache.get<UtilisationExportRow[]>(cacheKey);
    if (cached) return cached;

    const wsObj = new Types.ObjectId(ctx.workspaceId);
    const filters = rangeToFilters(range.from, range.to, tz);

    // CR-01 fix: resolve locationIds → machine set, intersect with scope.
    const locationMachineIds = await this.resolveMachineIdsForLocations(
      wsObj,
      ctx.requestedLocationIds,
    );

    // Resolve machine list (requested ∩ scope ∩ locations, all server-derived).
    const requestedObjs = ctx.requestedMachineIds?.map(
      (id) => new Types.ObjectId(id),
    );
    const effectiveMachineObjs = this.intersectMachineSets(
      requestedObjs,
      ctx.scopedMachineIds,
      locationMachineIds,
    );
    const machineFilter: Record<string, unknown> = {
      workspaceId: wsObj,
      isDeleted: false,
    };
    if (effectiveMachineObjs !== undefined) {
      // Intersection result (possibly empty) — empty short-circuits below.
      if (effectiveMachineObjs.length === 0) {
        this.cache.set(cacheKey, []);
        return [];
      }
      machineFilter._id = { $in: effectiveMachineObjs };
    }
    const machines = await this.machineModel
      .find(machineFilter, {
        _id: 1,
        name: 1,
        machineCode: 1,
        locationId: 1,
        primaryMetric: 1,
        uptimeTargetPct: 1,
      })
      .lean();
    if (machines.length === 0) {
      this.cache.set(cacheKey, []);
      return [];
    }
    const machineIds: Types.ObjectId[] = (machines as any[]).map(
      (mm: any) => mm._id,
    );

    // Resolve location names for the machine set.
    const locationIdHex = new Set<string>();
    for (const mm of machines as any[]) {
      if (mm.locationId) locationIdHex.add(String(mm.locationId));
    }
    const locationIds = Array.from(locationIdHex).map(
      (id) => new Types.ObjectId(id),
    );
    const locations =
      locationIds.length > 0
        ? await this.locationModel
            .find(
              { _id: { $in: locationIds }, workspaceId: wsObj },
              { name: 1 },
            )
            .lean()
        : [];
    const locNameById = new Map<string, string>(
      (locations as any[]).map((l: any) => [String(l._id), l.name as string]),
    );

    const shiftObjs = ctx.requestedShiftIds?.map(
      (id) => new Types.ObjectId(id),
    );

    // Output sums (split by primaryMetric per Pitfall 5).
    const outRows = await this.productionLogModel.aggregate(
      buildExportOutputPipeline({
        workspaceId: wsObj,
        machineIds,
        fromYmd: range.from,
        toYmd: range.to,
        shiftIds: shiftObjs,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );
    // CR-02 fix: do NOT collapse across metrics (Pitfall 5). Index outputs
    // by machine → list of {metric, output} so the row builder can emit one
    // row per (machine, metric) and downstream PDF/Excel renderers can keep
    // the units distinct (stitches vs pieces vs hours are unit-incompatible).
    const outsByMachine = new Map<
      string,
      Array<{ output: number; metric: string }>
    >();
    for (const r of outRows as any[]) {
      const mKey = String(r._id.machineId);
      const list = outsByMachine.get(mKey) ?? [];
      list.push({ output: r.output, metric: r._id.metric });
      outsByMachine.set(mKey, list);
    }

    // Top reasons by machine (raw minutes — not shift-clipped; used only
    // as a label for "what hurt most"; clipped totals come from ShiftClipper).
    const reasonRows = await this.downtimeModel.aggregate(
      buildExportTopReasonPipeline({
        workspaceId: wsObj,
        machineIds,
        fromUtc: filters.downtimeStartAtFilter.$gte,
        toUtc: filters.downtimeStartAtFilter.$lte,
      }),
      { maxTimeMS: 25000, allowDiskUse: true },
    );
    const reasonByMachine = new Map<
      string,
      { topReason: string; totalDownMin: number }
    >();
    for (const r of reasonRows as any[]) {
      reasonByMachine.set(String(r._id), {
        topReason: r.topReason,
        totalDownMin: r.totalDownMin,
      });
    }

    // Scheduled + clipped down per machine for the full range (one pass).
    const sched = await this.shiftClipper.scheduledMinutesByMachine(
      ctx.workspaceId,
      machineIds,
      { fromYmd: range.from, toYmd: range.to },
      tz,
      ctx.requestedShiftIds,
    );
    const downRowsRaw = await this.downtimeModel
      .find(
        {
          workspaceId: wsObj,
          machineId: { $in: machineIds },
          isDeleted: false,
          startAt: filters.downtimeStartAtFilter,
        },
        { machineId: 1, startAt: 1, endAt: 1 },
      )
      .lean();
    const down = await this.shiftClipper.clipDowntimeToShifts(
      ctx.workspaceId,
      machineIds,
      downRowsRaw as any,
      { fromYmd: range.from, toYmd: range.to },
      tz,
      ctx.requestedShiftIds,
    );

    const wsTarget = await this.resolveWorkspaceTargetPct(ctx.workspaceId);
    // CR-02 fix: emit one row per (machine, metric). When a machine logged
    // in two metrics within the range, BOTH rows survive — Pitfall 5.
    // If a machine has zero output in the range, emit a single row with
    // zero output keyed on the machine's own primaryMetric snapshot.
    const rows: UtilisationExportRow[] = [];
    for (const mm of machines as any[]) {
      const mKey = (mm._id as Types.ObjectId).toHexString();
      const outs = outsByMachine.get(mKey) ?? [];
      const re = reasonByMachine.get(mKey);
      const schedTotal = sched.get(mKey) ?? 0;
      const downTotal = down.get(mKey) ?? 0;
      const uptimePct =
        schedTotal > 0
          ? Math.max(
              0,
              Math.round(
                ((schedTotal - downTotal) / schedTotal) * 100 * 100,
              ) / 100,
            )
          : 0;
      const baseRow = {
        machineCode: mm.machineCode ?? '—',
        machineName: mm.name ?? '—',
        locationName: mm.locationId
          ? locNameById.get(String(mm.locationId)) ?? '—'
          : '—',
        uptimePct,
        downtimeMinutes: downTotal,
        topReasonLabel: re?.topReason ?? '—',
        scheduledMinutes: schedTotal,
        targetPct: mm.uptimeTargetPct ?? wsTarget,
        periodFrom: range.from,
        periodTo: range.to,
      };
      if (outs.length === 0) {
        rows.push({
          ...baseRow,
          outputTotal: 0,
          outputMetric: mm.primaryMetric ?? 'pieces',
        });
      } else {
        for (const o of outs) {
          rows.push({
            ...baseRow,
            outputTotal: o.output,
            outputMetric: o.metric,
          });
        }
      }
    }
    this.cache.set(cacheKey, rows);
    return rows;
  }
}

// ---------------- internal tz/date helpers ----------------
// Backend has no dayjs; mirror the Intl-based pattern from helpers/tz-range.ts
// and aggregations/shift-clipper.ts. en-CA returns YYYY-MM-DD natively.

function formatYmdInTz(d: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(d);
}

/** ISO week containing `ymd` (Mon-Sun) per D-08. */
function isoWeekRangeYmd(ymd: string): {
  weekFromYmd: string;
  weekToYmd: string;
} {
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  const dow = probe.getUTCDay(); // 0=Sun..6=Sat
  // ISO weekday: Mon=1..Sun=7. Days back to Monday = (dow + 6) % 7.
  const offsetToMonday = (dow + 6) % 7;
  const monday = new Date(probe.getTime() - offsetToMonday * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return {
    weekFromYmd: monday.toISOString().slice(0, 10),
    weekToYmd: sunday.toISOString().slice(0, 10),
  };
}

function monthRangeYmd(ymd: string): {
  monthFromYmd: string;
  monthToYmd: string;
} {
  const [y, m] = ymd.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  // Day 0 of next month = last day of this month.
  const last = new Date(Date.UTC(y, m, 0));
  return {
    monthFromYmd: first.toISOString().slice(0, 10),
    monthToYmd: last.toISOString().slice(0, 10),
  };
}

function previousMonthRangeYmd(ymd: string): {
  monthFromYmd: string;
  monthToYmd: string;
} {
  const [y, m] = ymd.split('-').map(Number);
  // Previous month: m-1 (1-based). Date.UTC handles year rollover.
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return {
    monthFromYmd: first.toISOString().slice(0, 10),
    monthToYmd: last.toISOString().slice(0, 10),
  };
}

function getTzOffsetMin(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function parseLocalStartOfDayUtc(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzOffsetMin = getTzOffsetMin(probe, tz);
  return new Date(
    Date.UTC(y, m - 1, d, 0, 0, 0, 0) - tzOffsetMin * 60 * 1000,
  );
}

function parseLocalEndOfDayUtc(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzOffsetMin = getTzOffsetMin(probe, tz);
  return new Date(
    Date.UTC(y, m - 1, d, 23, 59, 59, 999) - tzOffsetMin * 60 * 1000,
  );
}

// ---------------- Phase 25 Plan 07 — period enumeration ----------------
// Backend has NO dayjs (the existing service uses Intl/Date for tz work);
// `enumeratePeriods` mirrors that pattern so callers stay dependency-free.
//
// `label` matches the `_id` produced by buildTrendOutputPipeline so the
// service can join output rows by label without a secondary index.
//
// `fromYmd`/`toYmd` are clipped to the request range so per-period uptime
// computation never sees days outside the user's window.

interface PeriodBucket {
  label: string;
  fromYmd: string;
  toYmd: string;
}

function enumeratePeriods(
  fromYmd: string,
  toYmd: string,
  granularity: TrendGranularity,
  _tz: string,
): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  if (granularity === 'daily') {
    for (const day of enumerateDaysYmd(fromYmd, toYmd)) {
      out.push({ label: day, fromYmd: day, toYmd: day });
    }
    return out;
  }

  if (granularity === 'weekly') {
    // ISO weeks (Mon-Sun) — label = 'GGGG-Www' (ISO week-numbering year).
    let cursor = isoWeekMondayYmd(fromYmd);
    while (cursor <= toYmd) {
      const sundayYmd = addDaysYmd(cursor, 6);
      const wkStart = cursor < fromYmd ? fromYmd : cursor;
      const wkEnd = sundayYmd > toYmd ? toYmd : sundayYmd;
      out.push({
        label: isoWeekLabel(cursor),
        fromYmd: wkStart,
        toYmd: wkEnd,
      });
      cursor = addDaysYmd(cursor, 7);
    }
    return out;
  }

  // monthly — label = 'YYYY-MM'.
  let cursor = startOfMonthYmd(fromYmd);
  while (cursor <= toYmd) {
    const monthEnd = endOfMonthYmd(cursor);
    const mStart = cursor < fromYmd ? fromYmd : cursor;
    const mEnd = monthEnd > toYmd ? toYmd : monthEnd;
    out.push({
      label: cursor.slice(0, 7),
      fromYmd: mStart,
      toYmd: mEnd,
    });
    cursor = addMonthsYmd(cursor, 1);
  }
  return out;
}

function enumerateDaysYmd(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const f = new Date(fromYmd + 'T00:00:00Z');
  const t = new Date(toYmd + 'T00:00:00Z');
  for (
    let d = new Date(f);
    d.getTime() <= t.getTime();
    d = new Date(d.getTime() + 86_400_000)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `ymd`. */
function isoWeekMondayYmd(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offsetToMonday);
  return d.toISOString().slice(0, 10);
}

/** ISO week label 'GGGG-Www' — matches Mongo `$dateToString` with `%G-W%V`. */
function isoWeekLabel(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00Z');
  // ISO algorithm: Thursday of the same week determines the week-numbering year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 4));
  const yearStartDayNum = (yearStart.getUTCDay() + 6) % 7;
  const week1Monday = new Date(yearStart);
  week1Monday.setUTCDate(yearStart.getUTCDate() - yearStartDayNum);
  const weekNum =
    Math.round(
      (d.getTime() - week1Monday.getTime()) / (7 * 86_400_000),
    ) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

function startOfMonthYmd(ymd: string): string {
  return ymd.slice(0, 7) + '-01';
}

function endOfMonthYmd(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number);
  // Day 0 of next month = last day of this month.
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

function addMonthsYmd(ymd: string, months: number): string {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

// ---------------- Phase 25 Plan 08 — heatmap helpers ----------------

/**
 * Inclusive YYYY-MM-DD enumeration. Thin alias over enumerateDaysYmd so the
 * heatmap path reads naturally; keeps the file dayjs-free.
 */
function enumerateDays(fromYmd: string, toYmd: string): string[] {
  return enumerateDaysYmd(fromYmd, toYmd);
}
