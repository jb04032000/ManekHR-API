/**
 * Phase 25 Plan 06 — Pure aggregation pipeline builders for ProductionLog.
 *
 * Pitfall references:
 *   - Pitfall 1: ProductionLog.date is `String 'YYYY-MM-DD'` — match with strings.
 *   - Pitfall 5: NEVER sum stitches+pieces+hours together. Always split-by-metric.
 *   - Pitfall 9: Caller MUST pass `{ maxTimeMS: 25000, allowDiskUse: true }`.
 *
 * Returns a single `$facet` payload that satisfies KPI cards 1, 2, 3, and 5
 * (today/week/month output split-by-metric + top 3 machines for current month).
 *
 * Card 4 (uptime %) and Card 6 (top reasons) live in `downtime.aggregations.ts`.
 */
import { Types } from 'mongoose';

/** Pitfall 5 — split-by-metric switch. Picks the right numeric field per
 *  ProductionLog.primaryMetric, defaulting to 0 when the field is null. */
export const METRIC_SWITCH_EXPR = {
  $switch: {
    branches: [
      {
        case: { $eq: ['$primaryMetric', 'stitches'] },
        then: { $ifNull: ['$stitchCount', 0] },
      },
      {
        case: { $eq: ['$primaryMetric', 'pieces'] },
        then: { $ifNull: ['$pieceCount', 0] },
      },
      {
        case: { $eq: ['$primaryMetric', 'hours'] },
        then: { $ifNull: ['$hoursLogged', 0] },
      },
    ],
    default: 0,
  },
};

export interface KpiOutputBoundaries {
  /** All inclusive YYYY-MM-DD strings in workspace tz (Pitfall 1). */
  todayYmd: string;
  weekFromYmd: string;
  weekToYmd: string;
  monthFromYmd: string;
  monthToYmd: string;
}

export interface KpiOutputPipelineOpts {
  workspaceId: Types.ObjectId;
  scopedMachineIds?: Types.ObjectId[];
  requestedMachineIds?: Types.ObjectId[];
  shiftIds?: Types.ObjectId[];
  boundaries: KpiOutputBoundaries;
}

/**
 * Build the $facet pipeline for ProductionLog covering today/week/month
 * output (split by metric) plus topMachines for the current month.
 *
 * Pre-`$match` is tightly scoped (workspaceId + isDeleted + month range +
 * scope) so $facet branches operate on the smallest possible doc set.
 */
export function buildKpiOutputPipeline(opts: KpiOutputPipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    isDeleted: false,
    // Pitfall 1: string range, not Date.
    date: {
      $gte: opts.boundaries.monthFromYmd,
      $lte: opts.boundaries.monthToYmd,
    },
  };
  const machineIds = opts.requestedMachineIds ?? opts.scopedMachineIds;
  if (machineIds && machineIds.length > 0) {
    baseMatch.machineId = { $in: machineIds };
  }
  if (opts.shiftIds && opts.shiftIds.length > 0) {
    baseMatch.shiftId = { $in: opts.shiftIds };
  }

  return [
    { $match: baseMatch },
    { $addFields: { metricValue: METRIC_SWITCH_EXPR } },
    {
      $facet: {
        todayByMetric: [
          { $match: { date: opts.boundaries.todayYmd } },
          {
            $group: {
              _id: '$primaryMetric',
              sum: { $sum: '$metricValue' },
            },
          },
        ],
        weekByMetric: [
          {
            $match: {
              date: {
                $gte: opts.boundaries.weekFromYmd,
                $lte: opts.boundaries.weekToYmd,
              },
            },
          },
          {
            $group: {
              _id: '$primaryMetric',
              sum: { $sum: '$metricValue' },
            },
          },
        ],
        monthByMetric: [
          {
            $group: {
              _id: '$primaryMetric',
              sum: { $sum: '$metricValue' },
            },
          },
        ],
        topMachines: [
          {
            $group: {
              _id: { machineId: '$machineId', metric: '$primaryMetric' },
              sum: { $sum: '$metricValue' },
            },
          },
          { $sort: { sum: -1 } },
          { $limit: 3 },
        ],
      },
    },
  ];
}

// ============================================================================
// Phase 25 Plan 07 — Trend pipeline (per-machine output line, D-10 + D-11).
//
// Granularity is server-derived from span (D-11, locked):
//   spanDays <= 31  → daily   (period label = 'YYYY-MM-DD')
//   spanDays <= 180 → weekly  (period label = ISO week 'GGGG-Www')
//   else            → monthly (period label = 'YYYY-MM')
//
// Daily groups by `$date` directly (Pitfall 1 — string field).
// Weekly/monthly convert via $dateFromString → $dateTrunc → $dateToString.
// $dateTrunc requires Mongo 5+ (already required by Phase 21/22).
// ============================================================================

// Re-export the canonical TrendGranularity type from `../types` so callers
// have a single source of truth. (types.ts also exports it for client code.)
export type { TrendGranularity } from '../types';
import type { TrendGranularity } from '../types';

/** D-11 locked granularity rule. Pure function — safe to import in tests. */
export function selectGranularity(spanDays: number): TrendGranularity {
  if (spanDays <= 31) return 'daily';
  if (spanDays <= 180) return 'weekly';
  return 'monthly';
}

export interface TrendOutputPipelineOpts {
  workspaceId: Types.ObjectId;
  machineId: Types.ObjectId;
  fromYmd: string;
  toYmd: string;
  granularity: TrendGranularity;
  /** Optional shift filter (subset of workspace shifts). */
  shiftIds?: Types.ObjectId[];
}

/**
 * Per-machine trend pipeline. Always single-machine (controller path param);
 * no scope $in clause needed at this layer because Plan 09 also calls
 * `assertWorkspaceMachines` defence-in-depth before this runs.
 *
 * Output rows: `{ _id: string (period label), output: number, primaryMetric: string }`.
 * Sorted ascending so the service can zip with enumeratePeriods deterministically.
 */
export function buildTrendOutputPipeline(opts: TrendOutputPipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    machineId: opts.machineId,
    isDeleted: false,
    // Pitfall 1: ProductionLog.date is a string — match with strings.
    date: { $gte: opts.fromYmd, $lte: opts.toYmd },
  };
  if (opts.shiftIds && opts.shiftIds.length > 0) {
    baseMatch.shiftId = { $in: opts.shiftIds };
  }

  // Daily: group by the raw date string. Weekly/monthly: bucket via $dateTrunc
  // after parsing the YYYY-MM-DD string into a Date.
  const groupId =
    opts.granularity === 'daily'
      ? '$date'
      : {
          $dateToString: {
            date: {
              $dateTrunc: {
                date: {
                  $dateFromString: {
                    dateString: '$date',
                    format: '%Y-%m-%d',
                  },
                },
                unit: opts.granularity === 'weekly' ? 'week' : 'month',
                startOfWeek: 'monday',
              },
            },
            format: opts.granularity === 'weekly' ? '%G-W%V' : '%Y-%m',
          },
        };

  return [
    { $match: baseMatch },
    { $addFields: { metricValue: METRIC_SWITCH_EXPR } },
    {
      $group: {
        _id: groupId,
        output: { $sum: '$metricValue' },
        primaryMetric: { $first: '$primaryMetric' },
      },
    },
    { $sort: { _id: 1 } },
  ];
}

// ============================================================================
// Phase 25 Plan 08 — Heatmap output pipeline (per-machine × per-day rollup,
// month-bound per D-13). One row per (machineId, date). Caller iterates the
// month days and joins with ShiftClipper output for utilisationPct.
// ============================================================================

export interface HeatmapOutputPipelineOpts {
  workspaceId: Types.ObjectId;
  machineIds: Types.ObjectId[];
  /** YYYY-MM-01 in workspace tz. */
  monthFromYmd: string;
  /** Last day of month YYYY-MM-DD in workspace tz. */
  monthToYmd: string;
  shiftIds?: Types.ObjectId[];
}

export function buildHeatmapOutputPipeline(opts: HeatmapOutputPipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    machineId: { $in: opts.machineIds },
    isDeleted: false,
    // Pitfall 1: date is a string, match with strings.
    date: { $gte: opts.monthFromYmd, $lte: opts.monthToYmd },
  };
  if (opts.shiftIds && opts.shiftIds.length > 0) {
    baseMatch.shiftId = { $in: opts.shiftIds };
  }
  return [
    { $match: baseMatch },
    { $addFields: { metricValue: METRIC_SWITCH_EXPR } },
    {
      $group: {
        _id: { machineId: '$machineId', date: '$date' },
        output: { $sum: '$metricValue' },
      },
    },
  ];
}

// ============================================================================
// Phase 25 Plan 08 — Export output pipeline (per-machine roll-up over arbitrary
// range, fed by F-14 export pipeline downstream). Groups by (machineId,
// primaryMetric) so Pitfall 5 holds — a machine that flipped metric mid-range
// surfaces as one row per metric, never silently summed across.
// ============================================================================

export interface ExportOutputPipelineOpts {
  workspaceId: Types.ObjectId;
  machineIds: Types.ObjectId[];
  fromYmd: string;
  toYmd: string;
  shiftIds?: Types.ObjectId[];
}

export function buildExportOutputPipeline(opts: ExportOutputPipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    machineId: { $in: opts.machineIds },
    isDeleted: false,
    date: { $gte: opts.fromYmd, $lte: opts.toYmd },
  };
  if (opts.shiftIds && opts.shiftIds.length > 0) {
    baseMatch.shiftId = { $in: opts.shiftIds };
  }
  return [
    { $match: baseMatch },
    { $addFields: { metricValue: METRIC_SWITCH_EXPR } },
    {
      $group: {
        _id: { machineId: '$machineId', metric: '$primaryMetric' },
        output: { $sum: '$metricValue' },
      },
    },
  ];
}
