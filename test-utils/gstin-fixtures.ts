/**
 * Phase 17 / FIN-16-02 — GSTIN test fixtures.
 *
 * Used by:
 *   __tests__/unit/finance/gstin/surepass-filing-status.spec.ts (Plan 03)
 *   __tests__/unit/party-intelligence/gstin-risk.spec.ts (Plan 03)
 *
 * No test framework imports — these are pure helpers consumed by spec files.
 */

import type {
  GstinFilingPeriod,
  GstinFilingStatus,
} from '../src/modules/finance/party-intelligence/gstin-monitor/filing-status.types';

/**
 * Mock SurePass HTTP response payload (envelope shape per
 * `.planning/phases/17-party-intelligence-crm/17-SUREPASS-SPIKE.md` §3).
 *
 * Returns the documented snake_case shape. Plan 03 mapper consumes
 * `data.filing_status` array. Until the spike is verified live, treat this
 * as the *assumed* shape — Plan 03 must reconcile against real responses.
 */
export function mockSurepassFilingResponse(opts: {
  gstin: string;
  /** If true, every period is FILED. */
  periodsAllFiled?: boolean;
  /** Index from-most-recent (0 = most recent) where filings start being missed. */
  missedFromIdx?: number;
  /** Number of months of GSTR-3B data to emit. Default 6. */
  count?: number;
}): {
  data: {
    gstin: string;
    filing_status: Array<{
      return_type: 'GSTR1' | 'GSTR3B';
      tax_period: string; // MMYYYY
      date_of_filing: string | null; // DD-MM-YYYY
      status: 'Filed' | 'Not Filed';
      mode_of_filing?: 'ONLINE' | 'OFFLINE';
      due_date: string;
    }>;
  };
  success: true;
} {
  const count = opts.count ?? 6;
  const allFiled = opts.periodsAllFiled ?? true;
  const missedFrom = opts.missedFromIdx ?? Number.MAX_SAFE_INTEGER;
  const now = new Date();
  const filings: any[] = [];

  for (let i = 0; i < count; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    const due = `20-${mm}-${yyyy}`; // GSTR-3B due 20th of next month
    const filed = allFiled && i >= missedFrom ? false : allFiled;
    filings.push({
      return_type: 'GSTR3B',
      tax_period: `${mm}${yyyy}`,
      date_of_filing: filed ? `15-${mm}-${yyyy}` : null,
      status: filed ? 'Filed' : 'Not Filed',
      mode_of_filing: 'ONLINE',
      due_date: due,
    });
  }

  return {
    data: { gstin: opts.gstin, filing_status: filings },
    success: true,
  };
}

/**
 * Builds a synthetic GstinFilingPeriod[] series for unit-testing
 * `deriveGstinRisk()` (D-12).
 *
 * Order: most-recent FIRST (index 0). Caller specifies status of the latest
 * 3 GSTR-3B periods; older periods default to FILED.
 *
 * Example:
 *   gstinPeriodsFixture({ last3Status: ['NOT_FILED', 'NOT_FILED', 'NOT_FILED'] })
 *   → returns 6 periods where the 3 most recent are NOT_FILED → CRITICAL.
 */
export function gstinPeriodsFixture(opts: {
  last3Status: Array<'FILED' | 'NOT_FILED'>;
  total?: number;
}): GstinFilingPeriod[] {
  const total = opts.total ?? 6;
  const result: GstinFilingPeriod[] = [];
  const now = new Date();

  for (let i = 0; i < total; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    const dueDate = new Date(date.getFullYear(), date.getMonth() + 1, 20);
    const wantedStatus = opts.last3Status[i] ?? 'FILED';
    const status: GstinFilingStatus =
      wantedStatus === 'FILED'
        ? 'FILED'
        : Date.now() > dueDate.getTime()
          ? 'OVERDUE'
          : 'NOT_FILED';
    result.push({
      return: 'GSTR-3B',
      period: `${mm}-${yyyy}`,
      dueDate,
      filedDate:
        wantedStatus === 'FILED'
          ? new Date(date.getFullYear(), date.getMonth() + 1, 15)
          : null,
      status,
    });
  }

  return result;
}
