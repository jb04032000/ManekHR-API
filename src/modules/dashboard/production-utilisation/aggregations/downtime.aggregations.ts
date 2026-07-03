/**
 * Phase 25 Plan 06 — Pure aggregation pipeline builders for DowntimeEntry.
 *
 * Covers KPI Card 4 (uptime %) feed + Card 6 (top 3 reasons by downMinutes).
 *
 * Pitfall references:
 *   - DowntimeEntry.startAt is `Date` (UTC instant) — match with Dates, not
 *     strings (separate from Pitfall 1 which is the ProductionLog string-date
 *     trap).
 *   - Pitfall 9: Caller MUST pass `{ maxTimeMS: 25000, allowDiskUse: true }`.
 *
 * `rawEntries` returns the minimal projection needed by ShiftClipper (Plan 05)
 * to compute clipped down-minutes per machine for the uptime numerator.
 */
import { Types } from 'mongoose';

export interface KpiDowntimeBoundaries {
  monthStartUtc: Date;
  monthEndUtc: Date;
  lastMonthStartUtc: Date;
  lastMonthEndUtc: Date;
}

export interface KpiDowntimePipelineOpts {
  workspaceId: Types.ObjectId;
  scopedMachineIds?: Types.ObjectId[];
  requestedMachineIds?: Types.ObjectId[];
  boundaries: KpiDowntimeBoundaries;
}

/**
 * Current-month $facet:
 *   - topReasons: top 3 reasonCodeSnapshot grouped by sum(durationMinutes)
 *   - rawEntries: projection-only feed for ShiftClipper.clipDowntimeToShifts
 */
export function buildKpiDowntimePipeline(opts: KpiDowntimePipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    isDeleted: false,
    startAt: {
      $gte: opts.boundaries.monthStartUtc,
      $lte: opts.boundaries.monthEndUtc,
    },
  };
  const machineIds = opts.requestedMachineIds ?? opts.scopedMachineIds;
  if (machineIds && machineIds.length > 0) {
    baseMatch.machineId = { $in: machineIds };
  }

  return [
    { $match: baseMatch },
    {
      $facet: {
        topReasons: [
          {
            $group: {
              _id: {
                key: '$reasonCodeSnapshot',
                label: '$reasonLabelSnapshot',
              },
              downMin: { $sum: { $ifNull: ['$durationMinutes', 0] } },
            },
          },
          { $sort: { downMin: -1 } },
          { $limit: 3 },
        ],
        // Minimal raw projection for ShiftClipper.clipDowntimeToShifts.
        // Keep _id so callers can dedupe if needed; drop the rest.
        rawEntries: [
          {
            $project: {
              _id: 0,
              machineId: 1,
              startAt: 1,
              endAt: 1,
            },
          },
        ],
      },
    },
  ];
}

/**
 * Last-month projection-only pipeline for the uptime delta vs prior month
 * (Card 4). Returns raw intervals for ShiftClipper to clip + sum.
 */
export function buildLastMonthDowntimePipeline(opts: KpiDowntimePipelineOpts) {
  const baseMatch: Record<string, unknown> = {
    workspaceId: opts.workspaceId,
    isDeleted: false,
    startAt: {
      $gte: opts.boundaries.lastMonthStartUtc,
      $lte: opts.boundaries.lastMonthEndUtc,
    },
  };
  const machineIds = opts.requestedMachineIds ?? opts.scopedMachineIds;
  if (machineIds && machineIds.length > 0) {
    baseMatch.machineId = { $in: machineIds };
  }
  return [
    { $match: baseMatch },
    {
      $project: {
        _id: 0,
        machineId: 1,
        startAt: 1,
        endAt: 1,
      },
    },
  ];
}

// ============================================================================
// Phase 25 Plan 07 — Trend downtime feed (per-machine raw entries).
//
// Returns minimal projection consumed by ShiftClipper.clipDowntimeToShifts
// per period bucket. Bounded UTC range filter (Pitfall 1 contrast — startAt is
// a real Date, not a string).
// ============================================================================

export interface TrendDowntimePipelineOpts {
  workspaceId: Types.ObjectId;
  machineId: Types.ObjectId;
  fromUtc: Date;
  toUtc: Date;
}

export function buildTrendDowntimePipeline(opts: TrendDowntimePipelineOpts) {
  return [
    {
      $match: {
        workspaceId: opts.workspaceId,
        machineId: opts.machineId,
        isDeleted: false,
        startAt: { $gte: opts.fromUtc, $lte: opts.toUtc },
      },
    },
    { $project: { _id: 0, machineId: 1, startAt: 1, endAt: 1 } },
  ];
}

// ============================================================================
// Phase 25 Plan 08 — Heatmap downtime feed (raw entries within month bounds).
//
// Returns minimal projection consumed by ShiftClipper.clipDowntimeToShifts on
// a per-(machine, day) basis. The caller filters down to per-day overlap
// before clipping (avoids re-querying Mongo for each cell).
// ============================================================================

export interface HeatmapDowntimePipelineOpts {
  workspaceId: Types.ObjectId;
  machineIds: Types.ObjectId[];
  monthStartUtc: Date;
  monthEndUtc: Date;
}

export function buildHeatmapDowntimePipeline(
  opts: HeatmapDowntimePipelineOpts,
) {
  return [
    {
      $match: {
        workspaceId: opts.workspaceId,
        machineId: { $in: opts.machineIds },
        isDeleted: false,
        startAt: { $gte: opts.monthStartUtc, $lte: opts.monthEndUtc },
      },
    },
    { $project: { _id: 0, machineId: 1, startAt: 1, endAt: 1 } },
  ];
}

// ============================================================================
// Phase 25 Plan 08 — Export top-reason pipeline (per-machine "top reason"
// label + total clipped-down minutes). Two-stage group: first by
// (machineId, reasonLabel), sort desc by minutes, then group again on
// machineId picking $first as the top reason.
// ============================================================================

export interface ExportTopReasonPipelineOpts {
  workspaceId: Types.ObjectId;
  machineIds: Types.ObjectId[];
  fromUtc: Date;
  toUtc: Date;
}

export function buildExportTopReasonPipeline(
  opts: ExportTopReasonPipelineOpts,
) {
  return [
    {
      $match: {
        workspaceId: opts.workspaceId,
        machineId: { $in: opts.machineIds },
        isDeleted: false,
        startAt: { $gte: opts.fromUtc, $lte: opts.toUtc },
      },
    },
    {
      $group: {
        _id: { machineId: '$machineId', reason: '$reasonLabelSnapshot' },
        downMin: { $sum: { $ifNull: ['$durationMinutes', 0] } },
      },
    },
    { $sort: { downMin: -1 } },
    {
      $group: {
        _id: '$_id.machineId',
        topReason: { $first: '$_id.reason' },
        totalDownMin: { $sum: '$downMin' },
      },
    },
  ];
}
