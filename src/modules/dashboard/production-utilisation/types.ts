/**
 * Phase 25 Plan 04 — shared types for the Production Utilisation Dashboard.
 *
 * These contracts are consumed by:
 *   - Plan 06 (KPI service)
 *   - Plan 07 (trend service)
 *   - Plan 08 (heatmap + export services)
 *   - Plan 09 (controller)
 *
 * Date strings are YYYY-MM-DD in workspace timezone (Pitfall 1 — ProductionLog
 * stores `date` as String). Numeric fields are plain `number` (no Decimal128
 * surfacing at this layer).
 */

export type PrimaryMetric = 'stitches' | 'pieces' | 'hours';

export interface ByMetricSums {
  stitches: number;
  pieces: number;
  hours: number;
}

export type UptimeBand = 'green' | 'amber' | 'red';

export interface UptimeKpi {
  actualPct: number;
  targetPct: number;
  deltaVsPriorMonthPct: number;
  band: UptimeBand;
}

export interface TopMachineEntry {
  machineId: string;
  machineName: string;
  output: number;
  metric: PrimaryMetric;
}

export interface TopReasonEntry {
  reasonCodeKey: string;
  reasonLabel: string;
  downMinutes: number;
}

export interface KpiFiltersEcho {
  from: string;
  to: string;
  machineIds?: string[];
  locationIds?: string[];
  shiftIds?: string[];
}

export interface KpiResponse {
  todayOutput: ByMetricSums;
  weekOutput: ByMetricSums;
  monthOutput: ByMetricSums;
  uptime: UptimeKpi;
  topMachines: TopMachineEntry[];
  topReasons: TopReasonEntry[];
  filtersEcho: KpiFiltersEcho;
}

export type TrendGranularity = 'daily' | 'weekly' | 'monthly';

export interface TrendPoint {
  period: string; // YYYY-MM-DD (daily) or ISO week / YYYY-MM (weekly/monthly)
  output: number;
  uptimePct: number;
  targetPct: number;
}

export interface TrendResponse {
  granularity: TrendGranularity;
  points: TrendPoint[];
}

export interface HeatmapCell {
  machineId: string;
  machineName: string;
  date: string; // YYYY-MM-DD
  utilisationPct: number;
  output: number;
  /**
   * CR-02 fix — Pitfall 5. Each machine has ONE primaryMetric, so per-cell
   * `output` is a single-metric sum (never mixes units). UI renders
   * `${output} ${outputMetric}` so callers can never present an unlabelled
   * unit-incompatible number.
   */
  outputMetric: PrimaryMetric;
  downMinutes: number;
}

export interface HeatmapMachineRef {
  id: string;
  name: string;
}

export interface HeatmapResponse {
  month: string; // YYYY-MM
  locationId: string;
  cells: HeatmapCell[];
  machines: HeatmapMachineRef[];
  days: string[]; // YYYY-MM-DD list for the month
}

export interface UtilisationExportRow {
  machineCode: string;
  machineName: string;
  locationName: string;
  outputTotal: number;
  outputMetric: string;
  uptimePct: number;
  downtimeMinutes: number;
  topReasonLabel: string;
  scheduledMinutes: number;
  targetPct: number;
  periodFrom: string;
  periodTo: string;
}
