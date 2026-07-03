/**
 * Phase 17 / FIN-16-02 — GSTIN filing-status types.
 *
 * Used by GstinProviderAdapter.fetchFilingStatus() (D-10) and
 * Party.intelligence.gstinFilings cache (D-11). Wave-1 plan 03 implements the
 * SurePass mapping; Wave-1 plan 03 also derives risk via deriveGstinRisk().
 */

/** Return kinds we surface on the timeline. GSTR-9 is annual; included for completeness. */
export type GstinReturnKind = 'GSTR-1' | 'GSTR-3B' | 'GSTR-9';

/** Per-period filing status (D-10). */
export type GstinFilingStatus = 'FILED' | 'NOT_FILED' | 'OVERDUE';

/**
 * One filing period per (return, period) pair.
 * `period` formatted MM-YYYY (e.g. '04-2025') for human display + sort.
 * `dueDate` is the statutory due date for the period.
 * `filedDate` null when not yet filed; `status` derived from dueDate vs now.
 */
export interface GstinFilingPeriod {
  return: GstinReturnKind;
  period: string; // 'MM-YYYY'
  dueDate: Date;
  filedDate: Date | null;
  status: GstinFilingStatus;
}
