export interface KpiValue {
  valuePaise: number;
  trendPct: number | null; // vs prior period; null if no prior data
}

// R7: a single overdue party row for the top-5 overdue panel.
export interface OverduePartyRow {
  partyId: string;
  name: string;
  overduePaise: number;
}

// R7: deemed-supply early warning - takas (lots) still at a job worker past 9 months,
// approaching the 365-day return deadline (Section 143 CGST).
export interface TakasWarning {
  count: number;
  oldestDays: number | null; // age of the oldest unreturned lot in days, null when none
}

export interface DashboardKpiResponse {
  revenue: KpiValue; // K-01
  outstanding: KpiValue; // K-02
  payables: KpiValue; // K-03
  cashPosition: KpiValue; // K-04
  bankPosition: KpiValue; // K-05
  gstLiability: KpiValue; // K-06
  // R7 additions (cached with the rest; reuse existing report data, no new heavy inline scans):
  stockValue: KpiValue; // K-07: total on-hand stock valuation
  brokerCommissionDue: KpiValue; // K-08: accrued broker (dalali) commission owed
  topOverdueParties: OverduePartyRow[]; // K-09: worst 5 receivable parties
  takasAtJobWorker: TakasWarning; // K-10: lots at a job worker > 9 months
}

export interface RevenueTrendMonth {
  month: string; // 'Apr', 'May', ... (3-letter abbreviation)
  period: string; // 'MMYYYY' format
  revenuePaise: number;
  collectedPaise: number;
}

export interface RevenueTrendResponse {
  months: RevenueTrendMonth[];
  mode: 'current_fy' | 'last_12_months';
}
