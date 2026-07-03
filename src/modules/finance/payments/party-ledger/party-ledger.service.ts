import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';

export interface PartyLedgerRow {
  entryDate: Date;
  entryType: string;
  sourceVoucherNumber: string;
  narration: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface AgingResult {
  partyId: Types.ObjectId;
  partyName: string;
  current: number;
  bucket0_30: number;
  bucket31_60: number;
  bucket61_90: number;
  bucket90plus: number;
  totalDue: number;
}

@Injectable()
export class PartyLedgerService {
  // Platform-bar observability: shared finance tracer. Read-only service —
  // aggregation queries get a span only (no PostHog events on reads).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
  ) {}

  async getPartyLedger(
    wsId: string,
    firmId: string,
    partyId: string,
    options: { fromDate?: Date; toDate?: Date; page?: number; limit?: number } = {},
  ): Promise<PartyLedgerRow[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPartyLedger',
      { workspaceId: wsId, firmId },
      async () => {
        const matchStage: Record<string, any> = {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          isReversed: false,
        };
        if (options.fromDate || options.toDate) {
          matchStage.entryDate = {};
          if (options.fromDate) matchStage.entryDate.$gte = options.fromDate;
          if (options.toDate) matchStage.entryDate.$lte = options.toDate;
        }

        const partyIdObj = new Types.ObjectId(partyId);

        return this.ledgerEntryModel.aggregate([
          { $match: matchStage },
          { $unwind: '$lines' },
          { $match: { 'lines.partyId': partyIdObj } },
          { $addFields: { movement: { $subtract: ['$lines.debit', '$lines.credit'] } } },
          { $sort: { entryDate: 1, _id: 1 } },
          {
            $setWindowFields: {
              sortBy: { entryDate: 1, _id: 1 },
              output: {
                runningBalance: {
                  $sum: '$movement',
                  window: { documents: ['unbounded', 'current'] },
                },
              },
            },
          },
          {
            $project: {
              entryDate: 1,
              entryType: 1,
              sourceVoucherNumber: 1,
              narration: 1,
              debit: '$lines.debit',
              credit: '$lines.credit',
              runningBalance: 1,
            },
          },
        ]);
      },
    );
  }

  async getAgingBuckets(wsId: string, firmId: string): Promise<AgingResult[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getAgingBuckets',
      { workspaceId: wsId, firmId },
      async () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return this.saleInvoiceModel.aggregate([
          {
            $match: {
              workspaceId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              state: 'posted',
              paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
              isDeleted: false,
            },
          },
          {
            $addFields: {
              daysPastDue: {
                $max: [0, { $divide: [{ $subtract: [today, '$dueDate'] }, 86400000] }],
              },
            },
          },
          {
            $group: {
              _id: '$partyId',
              partyName: { $first: '$partySnapshot.name' },
              current: {
                $sum: { $cond: [{ $lte: ['$daysPastDue', 0] }, '$amountDuePaise', 0] },
              },
              bucket0_30: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ['$daysPastDue', 0] }, { $lte: ['$daysPastDue', 30] }] },
                    '$amountDuePaise',
                    0,
                  ],
                },
              },
              bucket31_60: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ['$daysPastDue', 30] }, { $lte: ['$daysPastDue', 60] }] },
                    '$amountDuePaise',
                    0,
                  ],
                },
              },
              bucket61_90: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ['$daysPastDue', 60] }, { $lte: ['$daysPastDue', 90] }] },
                    '$amountDuePaise',
                    0,
                  ],
                },
              },
              bucket90plus: {
                $sum: { $cond: [{ $gt: ['$daysPastDue', 90] }, '$amountDuePaise', 0] },
              },
              totalDue: { $sum: '$amountDuePaise' },
            },
          },
          { $sort: { totalDue: -1 } },
        ]);
      },
    );
  }

  async getReceivablesSummary(
    wsId: string,
    firmId: string,
  ): Promise<{
    totalOutstanding: number;
    totalOverdue: number;
    collectedThisMonth: number;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getReceivablesSummary',
      { workspaceId: wsId, firmId },
      async () => {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [outstanding, collected] = await Promise.all([
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
                state: 'posted',
                paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
                isDeleted: false,
              },
            },
            {
              $group: {
                _id: null,
                totalOutstanding: { $sum: '$amountDuePaise' },
                totalOverdue: {
                  $sum: {
                    $cond: [{ $eq: ['$paymentStatus', 'overdue'] }, '$amountDuePaise', 0],
                  },
                },
              },
            },
          ]),
          this.ledgerEntryModel.aggregate([
            {
              $match: {
                workspaceId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
                entryType: 'payment_in',
                entryDate: { $gte: startOfMonth },
                isReversed: false,
              },
            },
            { $unwind: '$lines' },
            {
              $match: { 'lines.accountCode': { $in: ['1001', '1002'] }, 'lines.debit': { $gt: 0 } },
            },
            { $group: { _id: null, collectedThisMonth: { $sum: '$lines.debit' } } },
          ]),
        ]);

        return {
          totalOutstanding: outstanding[0]?.totalOutstanding ?? 0,
          totalOverdue: outstanding[0]?.totalOverdue ?? 0,
          collectedThisMonth: collected[0]?.collectedThisMonth ?? 0,
        };
      },
    );
  }

  async getOutstandingInvoicesForParty(
    wsId: string,
    firmId: string,
    partyId: string,
  ): Promise<any[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getOutstandingInvoicesForParty',
      { workspaceId: wsId, firmId },
      async () => {
        return this.saleInvoiceModel
          .find({
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            partyId: new Types.ObjectId(partyId),
            state: 'posted',
            paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
            isDeleted: false,
          })
          .select(
            '_id voucherNumber voucherDate dueDate grandTotalPaise amountDuePaise paymentStatus',
          )
          .sort({ dueDate: 1 })
          .lean();
      },
    );
  }
}
