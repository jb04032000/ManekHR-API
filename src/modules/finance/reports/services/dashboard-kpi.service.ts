import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { BrokerCommissionEntry } from '../../payments/broker-commission/broker-commission.schema';
import { JobWorkLot } from '../../job-work/jw-lot/jw-lot.schema';
import type {
  DashboardKpiResponse,
  RevenueTrendResponse,
  RevenueTrendMonth,
  OverduePartyRow,
  TakasWarning,
} from '../dto/dashboard-kpi.dto';
import type {
  AccountingDashboardResponse,
  AccountingDashboardOpts,
  CashMovementMonth,
} from '../dto/accounting-dashboard.dto';
import { withFinanceSpan } from '../../common/finance-observability';
import { ReportCacheService } from '../../report-cache/report-cache.service';
import { StockSummaryService } from '../../inventory/stock-summary/stock-summary.service';
// Combined accounting-dashboard fans out to these two sibling report services
// (same ReportsModule, no circular dependency — neither depends on this service).
import { FinancialStatementsService } from './financial-statements.service';
import { PartyLedgerService } from './party-ledger.service';

@Injectable()
export class DashboardKpiService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only dashboard KPIs: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
    // R7 dashboard tiles: broker-commission register (K-08) + job-work lots (K-10).
    @InjectModel(BrokerCommissionEntry.name)
    private readonly brokerCommissionModel: Model<BrokerCommissionEntry>,
    @InjectModel(JobWorkLot.name) private readonly jwLotModel: Model<JobWorkLot>,
    private readonly reportCache: ReportCacheService,
    // R7: reuse the stock valuation report for the stock-value tile (K-07) - no second valuation path.
    private readonly stockSummary: StockSummaryService,
    // Combined accounting-dashboard delegates to these for P&L trend / balance sheet /
    // cash flow / ratios / EBITDA (fsService) and receivables/payables aging (partyLedger).
    // Injected to avoid re-implementing any aggregation here.
    private readonly fsService: FinancialStatementsService,
    private readonly partyLedger: PartyLedgerService,
  ) {}

  // Dashboard KPIs — 6 parallel aggregates over ledger/invoices/bills.
  async getDashboardKpis(wsId: string, firmId: string): Promise<DashboardKpiResponse> {
    // D17: cache the computed KPIs keyed by the firm's data version + current month. Any posting
    // bumps the version (invalidating the cache); the month component refreshes the "this month"
    // figures at the month boundary. A miss runs computeDashboardKpis (the live aggregation) + caches.
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.reportCache.getOrCompute(wsId, firmId, `dashboard-kpis:${monthKey}`, () =>
      this.computeDashboardKpis(wsId, firmId),
    );
  }

  private async computeDashboardKpis(wsId: string, firmId: string): Promise<DashboardKpiResponse> {
    return withFinanceSpan(
      this.tracer,
      'finance.getDashboardKpis',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

        const [revenue, outstanding, payables, cashPosition, bankPosition, gstLiability] =
          await Promise.all([
            // K-01: Revenue this month — sum of sale_invoice entryType credit for income accounts
            this.ledgerModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    entryType: 'sale_invoice',
                    entryDate: { $gte: monthStart, $lte: now },
                    isReversed: false,
                  },
                },
                { $unwind: '$lines' },
                {
                  $lookup: {
                    from: 'accounts',
                    localField: 'lines.accountId',
                    foreignField: '_id',
                    as: 'acct',
                  },
                },
                { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
                { $match: { 'acct.type': 'income' } },
                { $group: { _id: null, total: { $sum: '$lines.credit' } } },
              ])
              .then((r) => ({ valuePaise: r[0]?.total ?? 0, trendPct: null as number | null })),

            // K-02: Outstanding receivables — SaleInvoice paymentStatus unpaid/partial/overdue
            this.invoiceModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    state: 'posted',
                    paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
                    isDeleted: false,
                  },
                },
                { $group: { _id: null, total: { $sum: '$amountDuePaise' } } },
              ])
              .then((r) => ({ valuePaise: r[0]?.total ?? 0, trendPct: null as number | null })),

            // K-03: Payables due — PurchaseBill paymentStatus unpaid/partial/overdue
            this.billModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    state: 'posted',
                    paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
                    isDeleted: false,
                  },
                },
                { $group: { _id: null, total: { $sum: '$amountDuePaise' } } },
              ])
              .then((r) => ({ valuePaise: r[0]?.total ?? 0, trendPct: null as number | null })),

            // K-04: Cash Position — account 1001 running balance
            this.ledgerModel
              .aggregate([
                { $match: { workspaceId: wsOid, firmId: firmOid, isReversed: false } },
                { $unwind: '$lines' },
                { $match: { 'lines.accountCode': '1001' } },
                {
                  $group: {
                    _id: null,
                    debit: { $sum: '$lines.debit' },
                    credit: { $sum: '$lines.credit' },
                  },
                },
              ])
              .then((r) => ({
                valuePaise: (r[0]?.debit ?? 0) - (r[0]?.credit ?? 0),
                trendPct: null as number | null,
              })),

            // K-05: Bank Position — accounts starting with 1002
            this.ledgerModel
              .aggregate([
                { $match: { workspaceId: wsOid, firmId: firmOid, isReversed: false } },
                { $unwind: '$lines' },
                { $match: { 'lines.accountCode': { $regex: /^1002/ } } },
                {
                  $group: {
                    _id: null,
                    debit: { $sum: '$lines.debit' },
                    credit: { $sum: '$lines.credit' },
                  },
                },
              ])
              .then((r) => ({
                valuePaise: (r[0]?.debit ?? 0) - (r[0]?.credit ?? 0),
                trendPct: null as number | null,
              })),

            // K-06: GST Liability this month — output GST account codes from CoA
            // GST output accounts: 2006 (IGST payable), 2007 (CGST payable), 2008 (SGST payable)
            this.ledgerModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    entryDate: { $gte: monthStart, $lte: now },
                    isReversed: false,
                  },
                },
                { $unwind: '$lines' },
                { $match: { 'lines.accountCode': { $in: ['2006', '2007', '2008'] } } },
                { $group: { _id: null, total: { $sum: '$lines.credit' } } },
              ])
              .then((r) => ({ valuePaise: r[0]?.total ?? 0, trendPct: null as number | null })),
          ]);

        // R7: four extra dashboard signals, computed alongside the six above so they share the
        // same cache entry. Each reuses existing report data; none adds a heavy inline full scan.
        const nineMonthsAgo = new Date(now);
        nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);

        const [stockValue, brokerCommissionDue, topOverdueParties, takasAtJobWorker] =
          await Promise.all([
            // K-07: stock value - reuse the stock-summary report's valuation KPI (no 2nd path).
            this.stockSummary
              .list(wsId, firmId, {})
              .then((r) => ({
                valuePaise: r.kpi.totalStockValuePaise,
                trendPct: null as number | null,
              }))
              .catch(() => ({ valuePaise: 0, trendPct: null as number | null })),

            // K-08: broker (dalali) commission accrued in the commission register (R-25). This is
            // the amount recorded as owed to brokers; the tile drills into the register for detail.
            this.brokerCommissionModel
              .aggregate([
                { $match: { workspaceId: wsOid, firmId: firmOid } },
                { $group: { _id: null, total: { $sum: '$commissionPaise' } } },
              ])
              .then((r) => ({ valuePaise: r[0]?.total ?? 0, trendPct: null as number | null })),

            // K-09: worst 5 receivable parties (posted, overdue). Name from partySnapshot to avoid
            // a per-row party lookup.
            this.invoiceModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    state: 'posted',
                    paymentStatus: 'overdue',
                    isDeleted: false,
                  },
                },
                {
                  $group: {
                    _id: '$partyId',
                    name: { $first: '$partySnapshot.name' },
                    overduePaise: { $sum: '$amountDuePaise' },
                  },
                },
                { $sort: { overduePaise: -1 } },
                { $limit: 5 },
              ])
              .then((rows): OverduePartyRow[] =>
                rows.map((r) => ({
                  partyId: String(r._id),
                  name: (r.name as string) ?? '',
                  overduePaise: r.overduePaise ?? 0,
                })),
              ),

            // K-10: takas (job-work lots) still at a job worker past 9 months, approaching the
            // 365-day deemed-supply deadline. Counts pending/partial lots inward >9 months ago.
            this.jwLotModel
              .aggregate([
                {
                  $match: {
                    workspaceId: wsOid,
                    firmId: firmOid,
                    isDeleted: false,
                    status: { $in: ['pending', 'partial'] },
                    inwardDate: { $lte: nineMonthsAgo },
                  },
                },
                { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: '$inwardDate' } } },
              ])
              .then(
                (r): TakasWarning => ({
                  count: r[0]?.count ?? 0,
                  oldestDays: r[0]?.oldest
                    ? Math.floor((now.getTime() - new Date(r[0].oldest).getTime()) / 86_400_000)
                    : null,
                }),
              ),
          ]);

        return {
          revenue,
          outstanding,
          payables,
          cashPosition,
          bankPosition,
          gstLiability,
          stockValue,
          brokerCommissionDue,
          topOverdueParties,
          takasAtJobWorker,
        };
      },
    );
  }

  async getRevenueTrend(
    wsId: string,
    firmId: string,
    mode: 'current_fy' | 'last_12_months' = 'current_fy',
  ): Promise<RevenueTrendResponse> {
    return withFinanceSpan(
      this.tracer,
      'finance.getRevenueTrend',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const now = new Date();
        let dateFrom: Date;
        if (mode === 'current_fy') {
          // Indian FY: April 1 of current/previous year
          const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          dateFrom = new Date(Date.UTC(fyStart, 3, 1)); // April = month 3 (0-indexed)
        } else {
          dateFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
        }

        // INFLOW-ONLY whitelist: this trend powers the public dashboard/revenue-trend
        // card (revenue + collected). Its response shape is inflow-only and other pages
        // depend on it, so payroll OUTFLOWS must NOT be mixed in here — they are surfaced
        // separately by computeCashMovementTrend() (used by the accounting-dashboard),
        // which carries the salary_payment/salary_advance outflow whitelist.
        const results = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryType: { $in: ['sale_invoice', 'payment_in'] },
              entryDate: { $gte: dateFrom, $lte: now },
              isReversed: false,
            },
          },
          {
            $group: {
              _id: {
                year: { $year: '$entryDate' },
                month: { $month: '$entryDate' },
                type: '$entryType',
              },
              total: { $sum: { $sum: '$lines.credit' } },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]);

        const MONTH_LABELS = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ];
        const monthMap = new Map<string, RevenueTrendMonth>();
        for (const r of results) {
          const key = `${String(r._id.month).padStart(2, '0')}${r._id.year}`;
          if (!monthMap.has(key)) {
            monthMap.set(key, {
              month: MONTH_LABELS[r._id.month - 1],
              period: key,
              revenuePaise: 0,
              collectedPaise: 0,
            });
          }
          const entry = monthMap.get(key);
          if (r._id.type === 'sale_invoice') entry.revenuePaise += r.total;
          if (r._id.type === 'payment_in') entry.collectedPaise += r.total;
        }

        return { months: Array.from(monthMap.values()), mode };
      },
    );
  }

  // ─── Consolidated Accounting Dashboard ───────────────────────────────────
  //
  // Single endpoint that fans out (Promise.all) to the EXISTING report services
  // and returns one combined envelope, so the web "Accounting Dashboard" page
  // makes ONE request instead of eight. Every slice is the verbatim return of an
  // existing method — NO aggregation is re-implemented here. All money stays in
  // PAISE. The combined result is cached via ReportCacheService keyed on the
  // firm's data-version (any posting bumps it, invalidating the entry) + the
  // 'accounting-dashboard' tag + the period window, so distinct periods cache
  // independently and a posting refreshes them all.
  async getAccountingDashboard(
    wsId: string,
    firmId: string,
    opts?: AccountingDashboardOpts,
  ): Promise<AccountingDashboardResponse> {
    const now = new Date();
    // Default period = current Indian FY (Apr 1 → now); as-of = now. Callers may
    // override any bound. The window is part of the cache key so an override does
    // not collide with the default-period entry.
    const dateTo = opts?.dateTo ?? now;
    const dateFrom =
      opts?.dateFrom ??
      (() => {
        // Indian FY start: April 1 of the current (or previous, pre-April) year —
        // mirrors getRevenueTrend's current_fy boundary for label consistency.
        const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
        return new Date(Date.UTC(fyStart, 3, 1));
      })();
    const asOfDate = opts?.asOfDate ?? now;

    // Period component of the cache key — ISO date stamps keep the key stable for
    // the same window and distinct across windows.
    const periodKey = `${dateFrom.toISOString().slice(0, 10)}_${dateTo
      .toISOString()
      .slice(0, 10)}_${asOfDate.toISOString().slice(0, 10)}`;

    return this.reportCache.getOrCompute(wsId, firmId, `accounting-dashboard:${periodKey}`, () =>
      this.computeAccountingDashboard(wsId, firmId, dateFrom, dateTo, asOfDate),
    );
  }

  private async computeAccountingDashboard(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    asOfDate: Date,
  ): Promise<AccountingDashboardResponse> {
    return withFinanceSpan(
      this.tracer,
      'finance.getAccountingDashboard',
      { workspaceId: wsId, firmId },
      async () => {
        // Fan out to the existing report producers. getDashboardKpis carries its own
        // inner cache; the rest are computed live for the requested window. Each call
        // reuses the method's existing signature — no aggregation duplicated here.
        const [
          kpis,
          pnl,
          balanceSheet,
          cashFlow,
          ratios,
          ebitda,
          receivablesAging,
          payablesAging,
          cashTrend,
        ] = await Promise.all([
          this.getDashboardKpis(wsId, firmId),
          this.fsService.getProfitLossComparison(wsId, firmId, dateFrom, dateTo),
          this.fsService.getBalanceSheet(wsId, firmId, asOfDate),
          this.fsService.getCashFlow(wsId, firmId, dateFrom, dateTo),
          this.fsService.getRatioAnalysis(wsId, firmId, dateFrom, dateTo),
          this.fsService.getEbitda(wsId, firmId, dateFrom, dateTo),
          this.partyLedger.getReceivablesAging(wsId, firmId, asOfDate),
          this.partyLedger.getPayablesAging(wsId, firmId, asOfDate),
          // OUTFLOW-aware cash trend (carries the salary_payment/salary_advance fix).
          this.computeCashMovementTrend(wsId, firmId, dateFrom, dateTo),
        ]);

        return {
          kpis,
          pnlTrend: pnl.months, // 12-mo P&L comparison rows
          balanceSheet: {
            // Trimmed view: totals + composition the dashboard charts. Detail rows
            // (assets/liabilities/capital) are passed through untouched from the
            // verbatim getBalanceSheet() result.
            totalAssetsPaise: balanceSheet.totalAssetsPaise,
            totalLiabilitiesCapitalPaise: balanceSheet.totalLiabilitiesCapitalPaise,
            isBalanced: balanceSheet.isBalanced,
            isUnaudited: balanceSheet.isUnaudited,
            asOfDate: balanceSheet.asOfDate,
            assetsComposition: balanceSheet.assets,
            liabilitiesComposition: balanceSheet.liabilities,
            capitalComposition: balanceSheet.capital,
          },
          cashFlow,
          ratios,
          ebitda,
          receivablesAging,
          payablesAging,
          cashTrend,
          period: { from: dateFrom, to: dateTo, asOfDate, label: 'current_fy' },
        };
      },
    );
  }

  // ─── Cash-movement trend (OUTFLOW-aware companion to getRevenueTrend) ─────
  //
  // KPI-gap fix: the public revenue-trend whitelist is inflow-only
  // (['sale_invoice','payment_in']) and its response shape can't carry an outflow
  // figure without breaking the pages that depend on it. This sibling aggregation
  // therefore owns the cash-OUTFLOW whitelist. payment_out (supplier payments) plus
  // salary_payment + salary_advance (payroll disbursements) are the OUTFLOW types —
  // money leaving via cash/bank. They are summed on the OUTFLOW side ONLY; payment_in
  // is the sole INFLOW type, so there is no double-count and no inflow contamination.
  // Money stays in PAISE.
  private async computeCashMovementTrend(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<CashMovementMonth[]> {
    const wsOid = new Types.ObjectId(wsId);
    const firmOid = new Types.ObjectId(firmId);

    // INFLOW = cash actually received; OUTFLOW = cash actually paid out (incl. payroll).
    const INFLOW_TYPES = ['payment_in'];
    const OUTFLOW_TYPES = ['payment_out', 'salary_payment', 'salary_advance'];

    const results = await this.ledgerModel.aggregate([
      {
        $match: {
          workspaceId: wsOid,
          firmId: firmOid,
          entryType: { $in: [...INFLOW_TYPES, ...OUTFLOW_TYPES] },
          entryDate: { $gte: dateFrom, $lte: dateTo },
          isReversed: false,
        },
      },
      // Cash/bank lines only (1001 Cash, 1002* Bank) so we measure real cash movement,
      // not the offsetting expense/party legs of the same voucher. Using the cash leg's
      // debit (received) for inflow and credit (paid) for outflow keeps the sign correct
      // regardless of which entryType posted it.
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $regex: /^100[12]/ } } },
      {
        $group: {
          _id: {
            year: { $year: '$entryDate' },
            month: { $month: '$entryDate' },
            type: '$entryType',
          },
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const MONTH_LABELS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const outflowSet = new Set(OUTFLOW_TYPES);
    const monthMap = new Map<string, CashMovementMonth>();
    for (const r of results) {
      const key = `${String(r._id.month).padStart(2, '0')}${r._id.year}`;
      if (!monthMap.has(key)) {
        monthMap.set(key, {
          month: MONTH_LABELS[r._id.month - 1],
          period: key,
          inflowPaise: 0,
          outflowPaise: 0,
          netPaise: 0,
        });
      }
      const entry = monthMap.get(key);
      if (outflowSet.has(r._id.type)) {
        // Outflow: cash leg is credited when money leaves.
        entry.outflowPaise += r.credit ?? 0;
      } else {
        // Inflow (payment_in): cash leg is debited when money arrives.
        entry.inflowPaise += r.debit ?? 0;
      }
    }
    // Net is derived last so it always equals inflow - outflow.
    return Array.from(monthMap.values()).map((m) => ({
      ...m,
      netPaise: m.inflowPaise - m.outflowPaise,
    }));
  }
}
