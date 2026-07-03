import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { PurchaseBill } from '../purchase-bill/purchase-bill.schema';
import { withFinanceSpan } from '../../common/finance-observability';

export interface AgingBucket {
  partyId: string;
  partyName: string;
  current: number; // voucherDate <= asOfDate (not yet due)
  b0_30: number; // 0-30 days overdue
  b31_60: number; // 31-60 days overdue
  b61_90: number; // 61-90 days overdue
  b90plus: number; // > 90 days overdue
  total: number;
}

export interface PayablesSummary {
  totalOutstandingPaise: number;
  counts: Record<string, number>;
}

/**
 * PayablesListingService — accounts-payable aging and summary.
 *
 * Aging buckets computed from PurchaseBill.voucherDate (invoice date) and asOfDate.
 * Buckets: current (0 days) | 0-30 | 31-60 | 61-90 | 90+
 */
@Injectable()
export class PayablesListingService {
  // Platform-bar observability: shared finance tracer. Read-only service — spans
  // only, no PostHog (no writes, no userId in these signatures).
  private readonly tracer = trace.getTracer('finance');

  constructor(@InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>) {}

  async getAgingBuckets(wsId: string, firmId: string, asOfDate?: Date): Promise<AgingBucket[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPayablesAging',
      { workspaceId: wsId, firmId },
      async () => {
        const asOf = asOfDate ?? new Date();

        const bills = await this.billModel
          .find({
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            state: 'posted',
            paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
            isDeleted: false,
          })
          .exec();

        const byVendor: Record<string, AgingBucket> = {};

        for (const bill of bills) {
          const vendorId = bill.partyId?.toString() ?? 'unknown';
          if (!byVendor[vendorId]) {
            byVendor[vendorId] = {
              partyId: vendorId,
              partyName: (bill.partySnapshot as any)?.name ?? 'Unknown Vendor',
              current: 0,
              b0_30: 0,
              b31_60: 0,
              b61_90: 0,
              b90plus: 0,
              total: 0,
            };
          }

          const due = bill.amountDuePaise;
          const daysPast = Math.floor(
            (asOf.getTime() - new Date(bill.voucherDate).getTime()) / (24 * 3600 * 1000),
          );
          const v = byVendor[vendorId];

          if (daysPast <= 0) {
            v.current += due;
          } else if (daysPast <= 30) {
            v.b0_30 += due;
          } else if (daysPast <= 60) {
            v.b31_60 += due;
          } else if (daysPast <= 90) {
            v.b61_90 += due;
          } else {
            v.b90plus += due;
          }
          v.total += due;
        }

        return Object.values(byVendor);
      },
    );
  }

  async getPayablesSummary(wsId: string, firmId: string): Promise<PayablesSummary> {
    return withFinanceSpan(
      this.tracer,
      'finance.getPayablesSummary',
      { workspaceId: wsId, firmId },
      async () => {
        const bills = await this.billModel
          .find({
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            state: 'posted',
            paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
            isDeleted: false,
          })
          .exec();

        const totalOutstandingPaise = bills.reduce((s, b) => s + (b.amountDuePaise || 0), 0);
        const counts = bills.reduce(
          (acc, b) => {
            acc[b.paymentStatus] = (acc[b.paymentStatus] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );

        return { totalOutstandingPaise, counts };
      },
    );
  }
}
