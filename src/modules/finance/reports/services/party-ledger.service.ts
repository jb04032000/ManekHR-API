import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { Party } from '../../parties/party.schema';
import { withFinanceSpan } from '../../common/finance-observability';

// ─── Interfaces ───────────────────────────────────────────────────────────────

// Mirror of AgingBucket from payables-listing.service.ts (exact field names required)
export interface ReceivableAgingBucket {
  partyId: string;
  partyName: string;
  current: number; // not yet due (daysPast <= 0)
  b0_30: number; // 0-30 days overdue
  b31_60: number; // 31-60 days overdue
  b61_90: number; // 61-90 days overdue
  b90plus: number; // > 90 days overdue
  total: number;
}

export interface PartyStatementRow {
  entryDate: Date;
  voucherNumber: string;
  voucherType: string;
  narration: string;
  debitPaise: number;
  creditPaise: number;
  runningBalancePaise: number;
  drOrCr: 'Dr' | 'Cr';
  sourceVoucherId: string;
  sourceVoucherType: string;
}

export interface PartyStatementReport {
  partyId: string;
  partyName: string;
  openingBalancePaise: number;
  openingDrOrCr: 'Dr' | 'Cr';
  rows: PartyStatementRow[];
  closingBalancePaise: number;
  closingDrOrCr: 'Dr' | 'Cr';
  dateFrom: Date;
  dateTo: Date;
}

export interface AccountLedgerRow {
  entryDate: Date;
  voucherNumber: string;
  voucherType: string;
  narration: string;
  debitPaise: number;
  creditPaise: number;
  runningBalancePaise: number;
  sourceVoucherId: string;
  sourceVoucherType: string;
}

export interface DaybookRow {
  entryDate: Date;
  voucherNumber: string;
  voucherType: string;
  narration: string;
  totalDebitPaise: number;
  totalCreditPaise: number;
  sourceVoucherId: string;
  sourceVoucherType: string;
}

@Injectable()
export class PartyLedgerService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only party/ledger reports: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
  ) {}

  // ─── Party Statement (R-19) ───────────────────────────────────────────────

  async getPartyStatement(
    wsId: string,
    firmId: string,
    partyId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<PartyStatementReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPartyStatement',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const partyOid = new Types.ObjectId(partyId);

        // Opening balance: all entries before dateFrom for this party
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
          { $match: { 'lines.partyId': partyOid } },
          {
            $group: {
              _id: null,
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
        ]);
        const openingDebit = openingRows[0]?.totalDebit ?? 0;
        const openingCredit = openingRows[0]?.totalCredit ?? 0;
        const openingBalancePaise = openingDebit - openingCredit;

        // Period entries sorted by entryDate ASC, createdAt ASC (server-side sort required for running balance)
        const entries = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.partyId': partyOid } },
          {
            $group: {
              _id: '$_id',
              entryDate: { $first: '$entryDate' },
              createdAt: { $first: '$createdAt' },
              sourceVoucherNumber: { $first: '$sourceVoucherNumber' },
              sourceVoucherType: { $first: '$sourceVoucherType' },
              sourceVoucherId: { $first: '$sourceVoucherId' },
              narration: { $first: '$narration' },
              debitPaise: { $sum: '$lines.debit' },
              creditPaise: { $sum: '$lines.credit' },
            },
          },
          { $sort: { entryDate: 1, createdAt: 1 } },
        ]);

        // Running balance MUST be computed server-side in sorted order (anti-pattern: never client-side)
        let runningBalance = openingBalancePaise;
        const rows: PartyStatementRow[] = entries.map((e) => {
          runningBalance += e.debitPaise - e.creditPaise;
          return {
            entryDate: e.entryDate,
            voucherNumber: e.sourceVoucherNumber ?? '',
            voucherType: e.sourceVoucherType ?? '',
            narration: e.narration ?? '',
            debitPaise: e.debitPaise,
            creditPaise: e.creditPaise,
            runningBalancePaise: Math.abs(runningBalance),
            drOrCr: runningBalance >= 0 ? 'Dr' : 'Cr',
            sourceVoucherId: e.sourceVoucherId?.toString() ?? '',
            sourceVoucherType: e.sourceVoucherType ?? '',
          };
        });

        const partyName = entries[0]?.partyName ?? partyId;

        return {
          partyId,
          partyName,
          openingBalancePaise: Math.abs(openingBalancePaise),
          openingDrOrCr: openingBalancePaise >= 0 ? 'Dr' : 'Cr',
          rows,
          closingBalancePaise: Math.abs(runningBalance),
          closingDrOrCr: runningBalance >= 0 ? 'Dr' : 'Cr',
          dateFrom,
          dateTo,
        };
      },
    );
  }

  // ─── Account Ledger (R-20) ────────────────────────────────────────────────

  async getAccountLedger(
    wsId: string,
    firmId: string,
    accountCode: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{
    accountName: string;
    openingBalancePaise: number;
    rows: AccountLedgerRow[];
    closingBalancePaise: number;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getAccountLedger',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

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
          { $match: { 'lines.accountCode': accountCode } },
          {
            $group: {
              _id: '$lines.accountName',
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
        ]);
        const openingBalance =
          (openingRows[0]?.totalDebit ?? 0) - (openingRows[0]?.totalCredit ?? 0);
        const accountName = openingRows[0]?._id ?? accountCode;

        const entries = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': accountCode } },
          {
            $group: {
              _id: '$_id',
              entryDate: { $first: '$entryDate' },
              createdAt: { $first: '$createdAt' },
              sourceVoucherNumber: { $first: '$sourceVoucherNumber' },
              sourceVoucherType: { $first: '$sourceVoucherType' },
              sourceVoucherId: { $first: '$sourceVoucherId' },
              narration: { $first: '$narration' },
              debitPaise: { $sum: '$lines.debit' },
              creditPaise: { $sum: '$lines.credit' },
            },
          },
          { $sort: { entryDate: 1, createdAt: 1 } },
        ]);

        let running = openingBalance;
        const rows: AccountLedgerRow[] = entries.map((e) => {
          running += e.debitPaise - e.creditPaise;
          return {
            entryDate: e.entryDate,
            voucherNumber: e.sourceVoucherNumber ?? '',
            voucherType: e.sourceVoucherType ?? '',
            narration: e.narration ?? '',
            debitPaise: e.debitPaise,
            creditPaise: e.creditPaise,
            runningBalancePaise: running,
            sourceVoucherId: e.sourceVoucherId?.toString() ?? '',
            sourceVoucherType: e.sourceVoucherType ?? '',
          };
        });

        return {
          accountName,
          openingBalancePaise: openingBalance,
          rows,
          closingBalancePaise: running,
        };
      },
    );
  }

  // ─── Daybook (R-21) ──────────────────────────────────────────────────────

  async getDaybook(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ): Promise<{
    rows: DaybookRow[];
    total: number;
    totalDebitPaise: number;
    totalCreditPaise: number;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getDaybook',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const skip = (page - 1) * limit;

        const [countResult, entries] = await Promise.all([
          this.ledgerModel.countDocuments({
            workspaceId: wsOid,
            firmId: firmOid,
            entryDate: { $gte: dateFrom, $lte: dateTo },
            isReversed: false,
          }),
          this.ledgerModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                entryDate: { $gte: dateFrom, $lte: dateTo },
                isReversed: false,
              },
            },
            { $sort: { entryDate: 1, createdAt: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                entryDate: 1,
                narration: 1,
                entryType: 1,
                sourceVoucherNumber: 1,
                sourceVoucherType: 1,
                sourceVoucherId: 1,
                totalDebitPaise: { $sum: '$lines.debit' },
                totalCreditPaise: { $sum: '$lines.credit' },
              },
            },
          ]),
        ]);

        const rows: DaybookRow[] = entries.map((e) => ({
          entryDate: e.entryDate,
          voucherNumber: e.sourceVoucherNumber ?? '',
          voucherType: e.sourceVoucherType ?? e.entryType ?? '',
          narration: e.narration ?? '',
          totalDebitPaise: e.totalDebitPaise,
          totalCreditPaise: e.totalCreditPaise,
          sourceVoucherId: e.sourceVoucherId?.toString() ?? '',
          sourceVoucherType: e.sourceVoucherType ?? '',
        }));

        const totals = rows.reduce(
          (acc, r) => ({
            totalDebitPaise: acc.totalDebitPaise + r.totalDebitPaise,
            totalCreditPaise: acc.totalCreditPaise + r.totalCreditPaise,
          }),
          { totalDebitPaise: 0, totalCreditPaise: 0 },
        );
        return { rows, total: countResult, ...totals };
      },
    );
  }

  // ─── Receivables Aging (R-22) — mirrors PayablesListingService.getAgingBuckets ─

  async getReceivablesAging(
    wsId: string,
    firmId: string,
    asOfDate?: Date,
  ): Promise<{ rows: ReceivableAgingBucket[]; summary: Record<string, number> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getReceivablesAging',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const asOf = asOfDate ?? new Date();

        const invoices = await this.invoiceModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
          })
          .lean()
          .exec();

        const byParty: Record<string, ReceivableAgingBucket> = {};
        for (const inv of invoices as any[]) {
          const pid = inv.partyId?.toString() ?? 'unknown';
          if (!byParty[pid]) {
            byParty[pid] = {
              partyId: pid,
              partyName: inv.partySnapshot?.name ?? 'Unknown',
              current: 0,
              b0_30: 0,
              b31_60: 0,
              b61_90: 0,
              b90plus: 0,
              total: 0,
            };
          }
          const due = inv.amountDuePaise ?? 0;
          const daysPast = Math.floor(
            (asOf.getTime() - new Date(inv.voucherDate).getTime()) / (24 * 3600 * 1000),
          );
          const v = byParty[pid];
          if (daysPast <= 0) v.current += due;
          else if (daysPast <= 30) v.b0_30 += due;
          else if (daysPast <= 60) v.b31_60 += due;
          else if (daysPast <= 90) v.b61_90 += due;
          else v.b90plus += due;
          v.total += due;
        }

        const rows = Object.values(byParty);
        const summary = rows.reduce(
          (acc, r) => ({
            current: (acc.current ?? 0) + r.current,
            b0_30: (acc.b0_30 ?? 0) + r.b0_30,
            b31_60: (acc.b31_60 ?? 0) + r.b31_60,
            b61_90: (acc.b61_90 ?? 0) + r.b61_90,
            b90plus: (acc.b90plus ?? 0) + r.b90plus,
            total: (acc.total ?? 0) + r.total,
          }),
          {} as Record<string, number>,
        );
        return { rows, summary };
      },
    );
  }

  // ─── Payables Aging (R-23) — mirrors ReceivablesAging from PurchaseBill ──

  async getPayablesAging(
    wsId: string,
    firmId: string,
    asOfDate?: Date,
  ): Promise<{ rows: ReceivableAgingBucket[]; summary: Record<string, number> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPayablesAging',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const asOf = asOfDate ?? new Date();

        const bills = await this.billModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
          })
          .lean()
          .exec();

        const byParty: Record<string, ReceivableAgingBucket> = {};
        for (const bill of bills as any[]) {
          const pid = bill.partyId?.toString() ?? 'unknown';
          if (!byParty[pid]) {
            byParty[pid] = {
              partyId: pid,
              partyName: bill.partySnapshot?.name ?? 'Unknown',
              current: 0,
              b0_30: 0,
              b31_60: 0,
              b61_90: 0,
              b90plus: 0,
              total: 0,
            };
          }
          const due = bill.amountDuePaise ?? 0;
          const daysPast = Math.floor(
            (asOf.getTime() - new Date(bill.voucherDate).getTime()) / (24 * 3600 * 1000),
          );
          const v = byParty[pid];
          if (daysPast <= 0) v.current += due;
          else if (daysPast <= 30) v.b0_30 += due;
          else if (daysPast <= 60) v.b31_60 += due;
          else if (daysPast <= 90) v.b61_90 += due;
          else v.b90plus += due;
          v.total += due;
        }

        const rows = Object.values(byParty);
        const summary = rows.reduce(
          (acc, r) => ({
            current: (acc.current ?? 0) + r.current,
            b0_30: (acc.b0_30 ?? 0) + r.b0_30,
            b31_60: (acc.b31_60 ?? 0) + r.b31_60,
            b61_90: (acc.b61_90 ?? 0) + r.b61_90,
            b90plus: (acc.b90plus ?? 0) + r.b90plus,
            total: (acc.total ?? 0) + r.total,
          }),
          {} as Record<string, number>,
        );
        return { rows, summary };
      },
    );
  }

  // ─── Voucher Registers (R-26 to R-32) ─────────────────────────────────────

  async getRegister(
    wsId: string,
    firmId: string,
    type: 'sales' | 'purchases' | 'payments-in' | 'payments-out' | 'journals',
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ): Promise<{ rows: any[]; total: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const entryTypeMap: Record<string, string[]> = {
          sales: ['sale_invoice'],
          purchases: ['purchase_bill'],
          'payments-in': ['payment_in'],
          'payments-out': ['payment_out'],
          journals: ['journal'],
        };
        const entryTypes = entryTypeMap[type] ?? [type];

        const [total, entries] = await Promise.all([
          this.ledgerModel.countDocuments({
            workspaceId: wsOid,
            firmId: firmOid,
            entryType: { $in: entryTypes },
            entryDate: { $gte: dateFrom, $lte: dateTo },
            isReversed: false,
          }),
          this.ledgerModel
            .find({
              workspaceId: wsOid,
              firmId: firmOid,
              entryType: { $in: entryTypes },
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            })
            .sort({ entryDate: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select(
              'entryDate sourceVoucherNumber sourceVoucherType sourceVoucherId narration lines entryType',
            )
            .lean()
            .exec(),
        ]);

        const rows = (entries as any[]).map((e) => ({
          entryDate: e.entryDate,
          voucherNumber: e.sourceVoucherNumber ?? '',
          voucherType: e.sourceVoucherType ?? e.entryType ?? '',
          narration: e.narration ?? '',
          totalDebitPaise: (e.lines ?? []).reduce((s: number, l: any) => s + (l.debit ?? 0), 0),
          totalCreditPaise: (e.lines ?? []).reduce((s: number, l: any) => s + (l.credit ?? 0), 0),
          sourceVoucherId: e.sourceVoucherId?.toString() ?? '',
          sourceVoucherType: e.sourceVoucherType ?? '',
        }));
        return { rows, total };
      },
    );
  }

  // ─── Broker Commission Register (R-25) ────────────────────────────────────

  async getBrokerCommission(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ rows: any[]; totalCommissionPaise: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getBrokerCommission',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const entries = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': '5006' } },
          {
            $group: {
              _id: '$lines.partyId',
              totalCommissionPaise: { $sum: '$lines.debit' },
              entries: { $sum: 1 },
            },
          },
          { $sort: { totalCommissionPaise: -1 } },
        ]);
        const rows = entries.map((r) => ({
          partyId: r._id?.toString() ?? '',
          totalCommissionPaise: r.totalCommissionPaise,
          entries: r.entries,
        }));
        const totalCommissionPaise = rows.reduce((s, r) => s + r.totalCommissionPaise, 0);
        return { rows, totalCommissionPaise };
      },
    );
  }

  // ─── Party-wise P&L (R-24) ────────────────────────────────────────────────

  async getPartyPl(
    wsId: string,
    firmId: string,
    partyId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ partyId: string; rows: any[] }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPartyPl',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const partyOid = new Types.ObjectId(partyId);

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
          { $match: { 'lines.partyId': partyOid } },
          {
            $group: {
              _id: { accountCode: '$lines.accountCode', accountName: '$lines.accountName' },
              totalDebit: { $sum: '$lines.debit' },
              totalCredit: { $sum: '$lines.credit' },
            },
          },
          { $sort: { '_id.accountCode': 1 } },
          {
            $project: {
              _id: 0,
              accountCode: '$_id.accountCode',
              accountName: '$_id.accountName',
              totalDebitPaise: '$totalDebit',
              totalCreditPaise: '$totalCredit',
            },
          },
        ]);
        return { partyId, rows };
      },
    );
  }

  // ─── Party-wise P&L (R-24, all parties) ────────────────────────────────────
  // One row per party: total sales (posted sale invoices) vs total purchases
  // (posted purchase bills) over the window, net = sales - purchases. Optional
  // partyType filter ('customer' | 'vendor'). Powers the party-wise-pl report.
  async getPartyWisePl(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    partyType?: string,
  ): Promise<{
    rows: Array<{
      partyId: string;
      partyName: string;
      partyType: string;
      salesPaise: number;
      purchasesPaise: number;
      netPaise: number;
    }>;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPartyWisePl',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const window = { $gte: dateFrom, $lte: dateTo };

        // Sales per party (posted, non-deleted sale invoices), at grand total.
        const salesAgg = await this.invoiceModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              state: 'posted',
              isDeleted: false,
              voucherDate: window,
              partyId: { $ne: null },
            },
          },
          { $group: { _id: '$partyId', salesPaise: { $sum: '$grandTotalPaise' } } },
        ]);
        // Purchases per party (posted, non-deleted purchase bills), at grand total.
        const purchasesAgg = await this.billModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              state: 'posted',
              isDeleted: false,
              voucherDate: window,
              partyId: { $ne: null },
            },
          },
          { $group: { _id: '$partyId', purchasesPaise: { $sum: '$grandTotalPaise' } } },
        ]);

        const byParty = new Map<string, { salesPaise: number; purchasesPaise: number }>();
        for (const r of salesAgg) {
          const id = String(r._id);
          byParty.set(id, { salesPaise: r.salesPaise ?? 0, purchasesPaise: 0 });
        }
        for (const r of purchasesAgg) {
          const id = String(r._id);
          const cur = byParty.get(id) ?? { salesPaise: 0, purchasesPaise: 0 };
          cur.purchasesPaise = r.purchasesPaise ?? 0;
          byParty.set(id, cur);
        }

        if (byParty.size === 0) return { rows: [] };

        // Resolve party name + type for the involved parties.
        const partyOids = [...byParty.keys()].map((id) => new Types.ObjectId(id));
        const parties = await this.partyModel
          .find({ _id: { $in: partyOids }, workspaceId: wsOid })
          .select('name partyType')
          .lean();
        const partyMeta = new Map<string, { name: string; partyType: string }>();
        for (const p of parties as any[]) {
          partyMeta.set(String(p._id), { name: p.name ?? '', partyType: p.partyType ?? '' });
        }

        const wanted = partyType ? partyType.toLowerCase() : undefined;
        const rows = [...byParty.entries()]
          .map(([id, v]) => {
            const meta = partyMeta.get(id) ?? { name: '', partyType: '' };
            return {
              partyId: id,
              partyName: meta.name,
              partyType: meta.partyType,
              salesPaise: v.salesPaise,
              purchasesPaise: v.purchasesPaise,
              netPaise: v.salesPaise - v.purchasesPaise,
            };
          })
          .filter((r) => (wanted ? r.partyType === wanted : true))
          .sort((a, b) => b.netPaise - a.netPaise);

        return { rows };
      },
    );
  }
}
