import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { Account } from '../../ledger/account.schema';
import { withFinanceSpan } from '../../common/finance-observability';

// ──── Interfaces ─────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  accountType: 'asset' | 'liability' | 'capital' | 'income' | 'expense';
  accountGroup: string;
  accountSubGroup: string;
  totalDebitPaise: number;
  totalCreditPaise: number;
  closingDebitPaise: number; // max(debit-credit, 0)
  closingCreditPaise: number; // max(credit-debit, 0)
}

export interface TrialBalanceReport {
  rows: TrialBalanceRow[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  isBalanced: boolean;
}

export interface PlSection {
  label: string;
  type: 'section_header' | 'account' | 'subtotal' | 'total';
  level: number; // for indentation: 0=section header, 1=account, 2=subtotal
  debitPaise?: number;
  creditPaise?: number;
  amountPaise: number; // net: positive = expense/loss, negative = income surplus
}

export interface ProfitLossReport {
  tradingAccount: PlSection[];
  grossProfitPaise: number;
  indirectItems: PlSection[];
  otherIncome: PlSection[];
  netProfitPaise: number; // negative = net loss
  isLoss: boolean;
  openingStockPaise: number;
  closingStockPaise: number;
  dateFrom: Date;
  dateTo: Date;
}

export interface ProfitLossComparisonMonth {
  period: string; // 'MMYYYY'
  label: string; // 'Apr 2024'
  revenuePaise: number;
  grossProfitPaise: number;
  netProfitPaise: number;
  grossProfitPct: number;
  netProfitPct: number;
}

export interface BalanceSheetEntry {
  code: string;
  name: string;
  group: string;
  subGroup: string;
  level: number;
  type: 'section_header' | 'account' | 'subtotal' | 'total';
  amountPaise: number;
}

export interface BalanceSheetReport {
  assets: BalanceSheetEntry[];
  totalAssetsPaise: number;
  liabilities: BalanceSheetEntry[];
  capital: BalanceSheetEntry[];
  totalLiabilitiesCapitalPaise: number;
  isBalanced: boolean;
  isUnaudited: boolean; // true until F-15 FY Close performed
  asOfDate: Date;
}

export interface CashFlowSection {
  label: string;
  items: Array<{ label: string; amountPaise: number }>;
  totalPaise: number;
}

export interface CashFlowReport {
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangePaise: number;
  openingCashPaise: number;
  closingCashPaise: number;
  isIndicative: boolean; // true for sub-FY date ranges
}

export interface RatioAnalysisReport {
  gpPct: number; // Gross Profit %
  npPct: number; // Net Profit %
  currentRatio: number; // Current Assets / Current Liabilities
  debtEquity: number; // Total Debt / Total Equity
  returnOnEquity: number; // Net Profit / Total Equity * 100
  workingCapitalPaise: number; // Current Assets - Current Liabilities
}

export interface EbitdaMonthlyTrendPoint {
  month: string; // 'Apr 2024' label
  ebitdaPaise: number;
}

export interface EbitdaReport {
  ebitdaPaise: number;
  depreciationPaise: number;
  interestPaise: number;
  taxPaise: number;
  netProfitPaise: number;
  ebitdaMarginPct: number;
  revenuePaise: number;
  cogsPaise: number;
  grossProfitPaise: number;
  operatingExpensesPaise: number;
  ebitPaise: number;
  ebtPaise: number;
  monthlyTrend: EbitdaMonthlyTrendPoint[];
}

@Injectable()
export class FinancialStatementsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only report generators: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
  ) {}

  // ─── Trial Balance (R-01) ─────────────────────────────────────────────────

  async getTrialBalance(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<TrialBalanceReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getTrialBalance',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const rows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          {
            $group: {
              _id: {
                accountId: '$lines.accountId',
                accountCode: '$lines.accountCode',
                accountName: '$lines.accountName',
              },
              totalDebitPaise: { $sum: '$lines.debit' },
              totalCreditPaise: { $sum: '$lines.credit' },
            },
          },
          {
            $lookup: {
              from: 'accounts',
              localField: '_id.accountId',
              foreignField: '_id',
              as: 'account',
            },
          },
          { $unwind: { path: '$account', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              accountType: { $ifNull: ['$account.type', 'unknown'] },
              accountGroup: { $ifNull: ['$account.group', ''] },
              accountSubGroup: { $ifNull: ['$account.subGroup', ''] },
              closingDebitPaise: {
                $max: [{ $subtract: ['$totalDebitPaise', '$totalCreditPaise'] }, 0],
              },
              closingCreditPaise: {
                $max: [{ $subtract: ['$totalCreditPaise', '$totalDebitPaise'] }, 0],
              },
            },
          },
          { $sort: { '_id.accountCode': 1 } },
          {
            $project: {
              _id: 0,
              accountCode: '$_id.accountCode',
              accountName: '$_id.accountName',
              accountType: 1,
              accountGroup: 1,
              accountSubGroup: 1,
              totalDebitPaise: 1,
              totalCreditPaise: 1,
              closingDebitPaise: 1,
              closingCreditPaise: 1,
            },
          },
        ]);

        const totalDebitPaise = rows.reduce((s: number, r: any) => s + r.closingDebitPaise, 0);
        const totalCreditPaise = rows.reduce((s: number, r: any) => s + r.closingCreditPaise, 0);
        return {
          rows,
          totalDebitPaise,
          totalCreditPaise,
          isBalanced: totalDebitPaise === totalCreditPaise,
        };
      },
    );
  }

  // ─── P&L (R-02) ──────────────────────────────────────────────────────────

  async getProfitLoss(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<ProfitLossReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getProfitLoss',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Fetch all account balances for the period
        const rows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          {
            $group: {
              _id: {
                accountCode: '$lines.accountCode',
                accountName: '$lines.accountName',
                accountId: '$lines.accountId',
              },
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
          {
            $lookup: {
              from: 'accounts',
              localField: '_id.accountId',
              foreignField: '_id',
              as: 'acct',
            },
          },
          { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              type: { $ifNull: ['$acct.type', 'unknown'] },
              group: { $ifNull: ['$acct.group', ''] },
              subGroup: { $ifNull: ['$acct.subGroup', ''] },
              // Net credit minus debit for income, net debit minus credit for expense
              netPaise: { $subtract: ['$totalCredit', '$totalDebit'] },
            },
          },
          { $sort: { '_id.accountCode': 1 } },
        ]);

        // Opening stock: LedgerEntry for account 1004 (Stock) before dateFrom
        const openingStockRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $lt: dateFrom },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': '1004' } },
          {
            $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } },
          },
        ]);
        const openingStockPaise = openingStockRows[0]?.net ?? 0;

        // Closing stock: Stock account (1004) net balance as of period END - same
        // basis as opening stock above. This is a PERIODIC trading account: purchases
        // post to 5001 Purchases (a direct expense) and sales post no COGS, so 1004 is
        // not moved by purchases/sales. The +closing - opening adjustment is therefore
        // REQUIRED to derive gross profit and is NOT double-counting.
        const closingStockRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': '1004' } },
          {
            $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } },
          },
        ]);
        const closingStockPaise = closingStockRows[0]?.net ?? 0;

        // Build P&L sections by grouping rows by type/subGroup
        const incomeRows = rows.filter((r: any) => r.type === 'income');
        const expenseRows = rows.filter((r: any) => r.type === 'expense');

        const directIncome = incomeRows.filter(
          (r: any) => r.subGroup === 'Trading Income' || r.subGroup === 'Direct Income',
        );
        const otherIncome = incomeRows.filter(
          (r: any) => r.subGroup !== 'Trading Income' && r.subGroup !== 'Direct Income',
        );
        const directExpenses = expenseRows.filter(
          (r: any) => r.subGroup === 'Direct Expenses' || r.subGroup === 'Cost of Goods Sold',
        );
        const indirectExpenses = expenseRows.filter(
          (r: any) => r.subGroup !== 'Direct Expenses' && r.subGroup !== 'Cost of Goods Sold',
        );

        const totalDirectIncomePaise = directIncome.reduce(
          (s: number, r: any) => s + r.netPaise,
          0,
        );
        const totalDirectExpensesPaise = directExpenses.reduce(
          (s: number, r: any) => s + Math.abs(r.netPaise),
          0,
        );
        // Gross Profit = Direct Income + Closing Stock - Opening Stock - Direct Expenses
        // (periodic trading account; opening/closing stock from the 1004 balance).
        const grossProfitPaise =
          totalDirectIncomePaise + closingStockPaise - openingStockPaise - totalDirectExpensesPaise;
        const totalIndirectExpenses = indirectExpenses.reduce(
          (s: number, r: any) => s + Math.abs(r.netPaise),
          0,
        );
        const totalOtherIncome = otherIncome.reduce((s: number, r: any) => s + r.netPaise, 0);
        const netProfitPaise = grossProfitPaise + totalOtherIncome - totalIndirectExpenses;

        const buildSections = (items: any[], sectionLabel: string): PlSection[] => {
          const out: PlSection[] = [
            { label: sectionLabel, type: 'section_header', level: 0, amountPaise: 0 },
          ];
          items.forEach((r: any) =>
            out.push({
              label: r._id.accountName,
              type: 'account',
              level: 1,
              amountPaise: r.netPaise,
            }),
          );
          return out;
        };

        return {
          tradingAccount: [
            ...buildSections(directIncome, 'Sales / Direct Income'),
            ...buildSections(directExpenses, 'Direct Expenses'),
          ],
          grossProfitPaise,
          indirectItems: buildSections(indirectExpenses, 'Indirect Expenses'),
          otherIncome: buildSections(otherIncome, 'Other Income'),
          netProfitPaise,
          isLoss: netProfitPaise < 0,
          openingStockPaise,
          closingStockPaise,
          dateFrom,
          dateTo,
        };
      },
    );
  }

  // ─── P&L Month-wise Comparison (R-03) ────────────────────────────────────

  async getProfitLossComparison(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ months: ProfitLossComparisonMonth[] }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getProfitLossComparison',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Aggregate month-wise revenue (income) and expenses
        const results = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          {
            $lookup: {
              from: 'accounts',
              localField: '$lines.accountId',
              foreignField: '_id',
              as: 'acct',
            },
          },
          { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: {
                year: { $year: '$entryDate' },
                month: { $month: '$entryDate' },
                accountType: { $ifNull: ['$acct.type', 'unknown'] },
                accountSubGroup: { $ifNull: ['$acct.subGroup', ''] },
              },
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]);

        // Group by month and compute gross / net profit per month
        const monthMap = new Map<string, ProfitLossComparisonMonth>();
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
        for (const r of results) {
          const key = `${String(r._id.month).padStart(2, '0')}${r._id.year}`;
          if (!monthMap.has(key)) {
            monthMap.set(key, {
              period: key,
              label: `${MONTH_LABELS[r._id.month - 1]} ${r._id.year}`,
              revenuePaise: 0,
              grossProfitPaise: 0,
              netProfitPaise: 0,
              grossProfitPct: 0,
              netProfitPct: 0,
            });
          }
          const entry = monthMap.get(key);
          const net = r.totalCredit - r.totalDebit;
          if (r._id.accountType === 'income') {
            entry.revenuePaise += net;
            if (
              r._id.accountSubGroup === 'Trading Income' ||
              r._id.accountSubGroup === 'Direct Income'
            ) {
              entry.grossProfitPaise += net;
            }
            entry.netProfitPaise += net;
          } else if (r._id.accountType === 'expense') {
            if (
              r._id.accountSubGroup === 'Direct Expenses' ||
              r._id.accountSubGroup === 'Cost of Goods Sold'
            ) {
              entry.grossProfitPaise -= Math.abs(net);
            }
            entry.netProfitPaise -= Math.abs(net);
          }
        }
        const months = Array.from(monthMap.values()).map((m) => ({
          ...m,
          grossProfitPct: m.revenuePaise > 0 ? (m.grossProfitPaise / m.revenuePaise) * 100 : 0,
          netProfitPct: m.revenuePaise > 0 ? (m.netProfitPaise / m.revenuePaise) * 100 : 0,
        }));
        return { months };
      },
    );
  }

  // ─── Balance Sheet (R-04) ────────────────────────────────────────────────

  async getBalanceSheet(wsId: string, firmId: string, asOfDate: Date): Promise<BalanceSheetReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getBalanceSheet',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Balance Sheet = cumulative from accounts_books_begin_date to asOfDate
        const rows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $lte: asOfDate },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          {
            $group: {
              _id: {
                accountId: '$lines.accountId',
                accountCode: '$lines.accountCode',
                accountName: '$lines.accountName',
              },
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
          {
            $lookup: {
              from: 'accounts',
              localField: '_id.accountId',
              foreignField: '_id',
              as: 'acct',
            },
          },
          { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              type: { $ifNull: ['$acct.type', 'unknown'] },
              group: { $ifNull: ['$acct.group', ''] },
              subGroup: { $ifNull: ['$acct.subGroup', ''] },
            },
          },
          { $sort: { '_id.accountCode': 1 } },
        ]);

        const assets: BalanceSheetEntry[] = [];
        const liabilities: BalanceSheetEntry[] = [];
        const capital: BalanceSheetEntry[] = [];
        let totalAssetsPaise = 0;
        let totalLiabilitiesCapitalPaise = 0;

        for (const r of rows) {
          // net = debit - credit (positive = debit balance). Totals use the SIGNED
          // contribution per side so the accounting identity holds even when an
          // account carries a contra balance (e.g. a debit-balance income from sales
          // returns, or a debit-balance sundry creditor from an advance): assets
          // contribute +net (debit-positive); liabilities, capital, and the dynamic
          // retained earnings from income/expense contribute -net (credit-positive).
          // Since sum(net) === 0 across a balanced ledger, totalAssets === totalLiab+
          // Capital by construction. (The previous Math.abs() mis-signed contra
          // balances, so the sheet could fail to balance.) For NORMAL balances this
          // is identical to the prior abs()-based code.
          const net = r.totalDebit - r.totalCredit;
          const entry: BalanceSheetEntry = {
            code: r._id.accountCode,
            name: r._id.accountName,
            group: r.group,
            subGroup: r.subGroup,
            level: 1,
            type: 'account',
            amountPaise: Math.abs(net),
          };
          if (r.type === 'asset') {
            assets.push(entry);
            totalAssetsPaise += net;
          } else if (r.type === 'liability') {
            liabilities.push(entry);
            totalLiabilitiesCapitalPaise += -net;
          } else if (r.type === 'capital') {
            capital.push(entry);
            totalLiabilitiesCapitalPaise += -net;
          }
          // income/expense → dynamic Retained Earnings (Pitfall 4), credit-positive.
          else if (r.type === 'income' || r.type === 'expense') {
            totalLiabilitiesCapitalPaise += -net;
          }
        }

        const isBalanced = Math.abs(totalAssetsPaise - totalLiabilitiesCapitalPaise) < 2; // allow 1 paise rounding
        return {
          assets,
          totalAssetsPaise,
          liabilities,
          capital,
          totalLiabilitiesCapitalPaise,
          isBalanced,
          isUnaudited: true, // Always true until F-15 FY Close
          asOfDate,
        };
      },
    );
  }

  // ─── Cash Flow (R-05) ────────────────────────────────────────────────────

  async getCashFlow(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<CashFlowReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getCashFlow',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Get net profit for the period (needed for indirect method starting point)
        const pl = await this.getProfitLoss(wsId, firmId, dateFrom, dateTo);
        const netProfit = pl.netProfitPaise;

        // Depreciation: account codes starting with '4' (expense), subGroup = 'Depreciation'
        const deprRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: /^4/ } } },
          {
            $lookup: {
              from: 'accounts',
              localField: '$lines.accountId',
              foreignField: '_id',
              as: 'acct',
            },
          },
          { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
          { $match: { 'acct.subGroup': 'Depreciation' } },
          { $group: { _id: null, total: { $sum: '$lines.debit' } } },
        ]);
        const depreciationPaise = deprRows[0]?.total ?? 0;

        // Cash + Bank: 1001 (Cash) and 1002* (Bank accounts). The period delta is the
        // actual cash movement; the cumulative balance strictly before the period is
        // the opening cash. (Previously only 1001 was summed - banks were dropped -
        // and opening/closing were derived backwards from the delta.)
        const CASH_BANK_RE = /^100[12]/;
        const cashRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: CASH_BANK_RE } } },
          {
            $group: {
              _id: null,
              debit: { $sum: '$lines.debit' },
              credit: { $sum: '$lines.credit' },
            },
          },
        ]);
        const cashDelta = (cashRows[0]?.debit ?? 0) - (cashRows[0]?.credit ?? 0);

        // Opening cash+bank = cumulative net (debit - credit) on those accounts
        // strictly BEFORE the period start.
        const openingRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $lt: dateFrom },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: CASH_BANK_RE } } },
          {
            $group: {
              _id: null,
              debit: { $sum: '$lines.debit' },
              credit: { $sum: '$lines.credit' },
            },
          },
        ]);
        const openingCashPaise = (openingRows[0]?.debit ?? 0) - (openingRows[0]?.credit ?? 0);

        // Fixed asset purchases: account code 2001* (Fixed Assets)
        const faRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: /^2001/ } } },
          {
            $group: {
              _id: null,
              purchased: { $sum: '$lines.debit' },
              disposed: { $sum: '$lines.credit' },
            },
          },
        ]);
        const assetPurchasesPaise = -(faRows[0]?.purchased ?? 0);
        const assetDisposalsPaise = faRows[0]?.disposed ?? 0;

        // Loans: account code 3001* (long-term loans)
        const loanRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: /^3001/ } } },
          {
            $group: {
              _id: null,
              inflows: { $sum: '$lines.credit' },
              repayments: { $sum: '$lines.debit' },
            },
          },
        ]);
        const loanInflowsPaise = loanRows[0]?.inflows ?? 0;
        const loanRepaymentsPaise = -(loanRows[0]?.repayments ?? 0);

        const operatingTotal = netProfit + depreciationPaise;
        const investingTotal = assetPurchasesPaise + assetDisposalsPaise;
        const financingTotal = loanInflowsPaise + loanRepaymentsPaise;
        const netChangePaise = operatingTotal + investingTotal + financingTotal;

        const isIndicative = true; // Always indicative per RESEARCH Open Question 3
        return {
          operating: {
            label: 'Operating Activities',
            items: [
              { label: 'Net Profit/(Loss)', amountPaise: netProfit },
              { label: 'Add: Depreciation', amountPaise: depreciationPaise },
            ],
            totalPaise: operatingTotal,
          },
          investing: {
            label: 'Investing Activities',
            items: [
              { label: 'Purchase of Fixed Assets', amountPaise: assetPurchasesPaise },
              { label: 'Proceeds from Asset Disposals', amountPaise: assetDisposalsPaise },
            ],
            totalPaise: investingTotal,
          },
          financing: {
            label: 'Financing Activities',
            items: [
              { label: 'Loan Inflows', amountPaise: loanInflowsPaise },
              { label: 'Loan Repayments', amountPaise: loanRepaymentsPaise },
            ],
            totalPaise: financingTotal,
          },
          netChangePaise,
          // Actual cash+bank balances (the indirect netChangePaise above is the
          // analytical estimate, shown separately and flagged indicative).
          openingCashPaise,
          closingCashPaise: openingCashPaise + cashDelta,
          isIndicative,
        };
      },
    );
  }

  // ─── Ratio Analysis (R-06) ───────────────────────────────────────────────

  async getRatioAnalysis(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<RatioAnalysisReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getRatioAnalysis',
      { workspaceId: wsId, firmId },
      async () => {
        const [pl, bs] = await Promise.all([
          this.getProfitLoss(wsId, firmId, dateFrom, dateTo),
          this.getBalanceSheet(wsId, firmId, dateTo),
        ]);
        const revenue = pl.tradingAccount
          .filter((s) => s.type === 'account')
          .reduce((sum, s) => sum + s.amountPaise, 0);
        const grossProfitPaise = pl.grossProfitPaise;
        const netProfitPaise = pl.netProfitPaise;

        const currentAssets = bs.assets
          .filter((a) => a.group === 'Current Assets')
          .reduce((s, a) => s + a.amountPaise, 0);
        const currentLiabilities = bs.liabilities
          .filter((l) => l.group === 'Current Liabilities')
          .reduce((s, l) => s + l.amountPaise, 0);
        const totalDebt = bs.liabilities.reduce((s, l) => s + l.amountPaise, 0);
        const totalEquity = bs.capital.reduce((s, c) => s + c.amountPaise, 0);

        return {
          gpPct: revenue > 0 ? (grossProfitPaise / revenue) * 100 : 0,
          npPct: revenue > 0 ? (netProfitPaise / revenue) * 100 : 0,
          currentRatio: currentLiabilities > 0 ? currentAssets / currentLiabilities : 0,
          debtEquity: totalEquity > 0 ? totalDebt / totalEquity : 0,
          returnOnEquity: totalEquity > 0 ? (netProfitPaise / totalEquity) * 100 : 0,
          workingCapitalPaise: currentAssets - currentLiabilities,
        };
      },
    );
  }

  // ─── EBITDA (R-07) ───────────────────────────────────────────────────────

  async getEbitda(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<EbitdaReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getEbitda',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const pl = await this.getProfitLoss(wsId, firmId, dateFrom, dateTo);

        // Revenue: direct income accounts (netPaise = credit - debit > 0 for income)
        const revenuePaise = pl.tradingAccount
          .filter((s) => s.type === 'account' && s.amountPaise > 0)
          .reduce((sum, s) => sum + s.amountPaise, 0);

        // COGS: direct expenses (netPaise = credit - debit < 0 for expenses)
        const cogsPaise = pl.tradingAccount
          .filter((s) => s.type === 'account' && s.amountPaise < 0)
          .reduce((sum, s) => sum + Math.abs(s.amountPaise), 0);

        const grossProfitPaise = pl.grossProfitPaise;

        // Depreciation: entryType = 'depreciation'
        const deprRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
              entryType: 'depreciation',
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.debit': { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: '$lines.debit' } } },
        ]);
        const depreciationPaise = deprRows[0]?.total ?? 0;

        // Interest: account code 5010 (Interest Expense) — from CoA seed
        const intRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': '5010' } },
          { $group: { _id: null, total: { $sum: '$lines.debit' } } },
        ]);
        const interestPaise = intRows[0]?.total ?? 0;

        // Tax: account code 4900 (Income Tax Expense) range — approximate
        const taxRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $regex: /^4900/ } } },
          { $group: { _id: null, total: { $sum: '$lines.debit' } } },
        ]);
        const taxPaise = taxRows[0]?.total ?? 0;

        // Indirect expenses minus depreciation/interest/tax to avoid double-counting EBITDA add-backs
        const indirectExpensesGrossPaise = pl.indirectItems
          .filter((s) => s.type === 'account')
          .reduce((sum, s) => sum + Math.abs(s.amountPaise), 0);
        const operatingExpensesPaise = Math.max(
          0,
          indirectExpensesGrossPaise - depreciationPaise - interestPaise - taxPaise,
        );

        const ebitdaPaise = pl.netProfitPaise + depreciationPaise + interestPaise + taxPaise;
        const ebitPaise = ebitdaPaise - depreciationPaise;
        const ebtPaise = ebitPaise - interestPaise;

        // Monthly EBITDA trend — last 12 months ending at dateTo (always 12 buckets, zero-filled)
        const trendStart = new Date(
          Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth() - 11, 1, 0, 0, 0, 0),
        );
        const trendEnd = new Date(
          Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth() + 1, 0, 23, 59, 59, 999),
        );

        const monthlyAgg = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: trendStart, $lte: trendEnd },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          {
            $lookup: {
              from: 'accounts',
              localField: '$lines.accountId',
              foreignField: '_id',
              as: 'acct',
            },
          },
          { $unwind: { path: '$acct', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: {
                year: { $year: '$entryDate' },
                month: { $month: '$entryDate' },
                accountType: { $ifNull: ['$acct.type', 'unknown'] },
                accountCode: '$lines.accountCode',
                entryType: '$entryType',
              },
              debit: { $sum: '$lines.debit' },
              credit: { $sum: '$lines.credit' },
            },
          },
        ]);

        type MonthBucket = { netProfit: number; depr: number; interest: number; tax: number };
        const bucket = new Map<string, MonthBucket>();
        for (const r of monthlyAgg) {
          const key = `${r._id.year}-${String(r._id.month).padStart(2, '0')}`;
          if (!bucket.has(key)) bucket.set(key, { netProfit: 0, depr: 0, interest: 0, tax: 0 });
          const b = bucket.get(key);
          const net = r.credit - r.debit;
          if (r._id.accountType === 'income') b.netProfit += net;
          else if (r._id.accountType === 'expense') b.netProfit -= Math.abs(net);
          if (r._id.entryType === 'depreciation' && r.debit > 0) b.depr += r.debit;
          if (r._id.accountCode === '5010') b.interest += r.debit;
          if (typeof r._id.accountCode === 'string' && r._id.accountCode.startsWith('4900'))
            b.tax += r.debit;
        }

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
        const monthlyTrend: EbitdaMonthlyTrendPoint[] = [];
        for (let i = 0; i < 12; i++) {
          const d = new Date(
            Date.UTC(trendStart.getUTCFullYear(), trendStart.getUTCMonth() + i, 1),
          );
          const y = d.getUTCFullYear();
          const m = d.getUTCMonth() + 1;
          const key = `${y}-${String(m).padStart(2, '0')}`;
          const b = bucket.get(key) ?? { netProfit: 0, depr: 0, interest: 0, tax: 0 };
          monthlyTrend.push({
            month: `${MONTH_LABELS[m - 1]} ${y}`,
            ebitdaPaise: b.netProfit + b.depr + b.interest + b.tax,
          });
        }

        return {
          ebitdaPaise,
          depreciationPaise,
          interestPaise,
          taxPaise,
          netProfitPaise: pl.netProfitPaise,
          ebitdaMarginPct: revenuePaise > 0 ? (ebitdaPaise / revenuePaise) * 100 : 0,
          revenuePaise,
          cogsPaise,
          grossProfitPaise,
          operatingExpensesPaise,
          ebitPaise,
          ebtPaise,
          monthlyTrend,
        };
      },
    );
  }
}
