/**
 * Accounting Dashboard — consolidated response DTO (purely additive endpoint).
 *
 * WHY: the web "Accounting Dashboard" page previously had to fan out 8 separate
 * report requests (KPIs + P&L trend + balance sheet + cash flow + ratios + EBITDA
 * + receivables/payables aging) to paint one screen. This DTO is the single
 * combined envelope returned by GET .../reports/dashboard/accounting so the page
 * makes ONE round-trip. Each field is the verbatim return shape of the existing
 * service method that produces it — no field is re-derived here, so the web type
 * can mirror these by importing/duplicating the same sub-types it already uses
 * for the individual report endpoints. Reusing the source types (instead of
 * redeclaring) guarantees this combined DTO can never drift from the per-report
 * responses other pages still depend on.
 *
 * MONEY: every *Paise field stays in PAISE (integer ×100) — identical to the
 * source reports. No rupee conversion happens at this layer.
 */
import type { DashboardKpiResponse } from './dashboard-kpi.dto';
import type {
  ProfitLossComparisonMonth,
  BalanceSheetReport,
  CashFlowReport,
  RatioAnalysisReport,
  EbitdaReport,
} from '../services/financial-statements.service';
import type { ReceivableAgingBucket } from '../services/party-ledger.service';

/**
 * Trimmed balance-sheet view for the dashboard card. We deliberately surface only
 * the totals + composition the dashboard renders (a full BalanceSheetReport carries
 * the entire line-item arrays, which the dashboard does not chart). The detailed
 * balance-sheet endpoint remains the source for drill-down. `assetsComposition` /
 * `liabilitiesComposition` are the same BalanceSheetEntry rows the detail endpoint
 * returns, passed through untouched so the web can reuse its existing row type.
 */
export interface AccountingDashboardBalanceSheet {
  totalAssetsPaise: number;
  totalLiabilitiesCapitalPaise: number;
  isBalanced: boolean;
  isUnaudited: boolean;
  asOfDate: Date;
  // Composition = the per-account rows grouped by side (verbatim from getBalanceSheet).
  assetsComposition: BalanceSheetReport['assets'];
  liabilitiesComposition: BalanceSheetReport['liabilities'];
  capitalComposition: BalanceSheetReport['capital'];
}

/**
 * Month bucket for the cash-movement trend. Unlike the public revenue-trend (which
 * is inflow-only: revenue + collected), this series carries BOTH sides so the
 * dashboard can chart net cash movement. WHY this exists: it is the OUTFLOW-aware
 * companion to getRevenueTrend — payroll disbursements (salary_payment /
 * salary_advance) and supplier payments (payment_out) land in `outflowPaise`, so
 * the dashboard's cash KPIs reflect money leaving the firm, not just money coming
 * in. `netPaise = inflowPaise - outflowPaise`.
 */
export interface CashMovementMonth {
  month: string; // 'Apr', 'May', ... (3-letter abbreviation)
  period: string; // 'MMYYYY'
  inflowPaise: number; // payment_in (cash actually received)
  outflowPaise: number; // payment_out + salary_payment + salary_advance (cash paid out)
  netPaise: number; // inflowPaise - outflowPaise
}

/**
 * The period window the trend/flow/ratio/ebitda slices were computed over, echoed
 * back so the web can label charts without re-deriving the FY boundaries.
 */
export interface AccountingDashboardPeriod {
  from: Date; // inclusive start (defaults to current Indian FY start, Apr 1)
  to: Date; // inclusive end (defaults to "now")
  asOfDate: Date; // balance-sheet + aging as-of (defaults to "now")
  label: string; // human label, e.g. 'current_fy'
}

export interface AccountingDashboardResponse {
  // KPI tiles — verbatim getDashboardKpis() (10 KPIs incl. cash/bank position).
  kpis: DashboardKpiResponse;
  // 12-month P&L comparison — verbatim getProfitLossComparison().months.
  pnlTrend: ProfitLossComparisonMonth[];
  // Balance-sheet totals + composition (trimmed view, see type above).
  balanceSheet: AccountingDashboardBalanceSheet;
  // Cash-flow statement — verbatim getCashFlow().
  cashFlow: CashFlowReport;
  // Liquidity / profitability ratios — verbatim getRatioAnalysis().
  ratios: RatioAnalysisReport;
  // EBITDA breakdown + monthly trend — verbatim getEbitda().
  ebitda: EbitdaReport;
  // Receivables aging buckets — verbatim getReceivablesAging().
  receivablesAging: { rows: ReceivableAgingBucket[]; summary: Record<string, number> };
  // Payables aging buckets — verbatim getPayablesAging().
  payablesAging: { rows: ReceivableAgingBucket[]; summary: Record<string, number> };
  // Month-wise cash inflow vs OUTFLOW (incl. payroll). Companion to the public
  // revenue-trend — surfaces salary_payment / salary_advance disbursements that the
  // inflow-only revenue-trend cannot show.
  cashTrend: CashMovementMonth[];
  // Window the period-scoped slices above were computed over.
  period: AccountingDashboardPeriod;
}

/**
 * Optional overrides for the accounting-dashboard period window. When omitted the
 * service defaults to the current Indian FY (Apr 1 → now) for trend/flow/ratio/
 * ebitda and "now" for balance-sheet + aging as-of.
 */
export interface AccountingDashboardOpts {
  dateFrom?: Date;
  dateTo?: Date;
  asOfDate?: Date;
}
