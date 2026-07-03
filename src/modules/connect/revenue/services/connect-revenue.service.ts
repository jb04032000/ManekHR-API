import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SubscriptionPayment } from '../../../subscriptions/billing/schemas/subscription-payment.schema';
import { Plan } from '../../../subscriptions/schemas/plan.schema';

/** Per-plan Connect subscription revenue (all amounts in paise). */
export interface ConnectPlanRevenueRow {
  planId: string;
  planName: string;
  tier: string;
  grossPaise: number;
  refundedPaise: number;
  netPaise: number;
  payments: number;
}

export interface ConnectRevenueSummary {
  subscription: {
    grossPaise: number;
    refundedPaise: number;
    netPaise: number;
    payments: number;
    byPlan: ConnectPlanRevenueRow[];
  };
}

/**
 * ManekHR Connect -- revenue rollups for the admin dashboard (Phase M3.3).
 *
 * Subscription revenue = captured SubscriptionPayments on Connect / bundle
 * plans, net of refunds. Boost / ad spend is read separately by the web
 * dashboard from the shipped `admin/connect/ads/revenue` endpoint (no need to
 * couple this service to the ads module). Paid-lead revenue is N/A (M2.4 was
 * dropped). Read-only: OTel-traced by the HTTP layer, no audit / PostHog.
 */
@Injectable()
export class ConnectRevenueService {
  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(Plan.name)
    private readonly planModel: Model<Plan>,
  ) {}

  async getSubscriptionRevenue(): Promise<ConnectRevenueSummary> {
    const empty: ConnectRevenueSummary = {
      subscription: { grossPaise: 0, refundedPaise: 0, netPaise: 0, payments: 0, byPlan: [] },
    };

    const plans = await this.planModel
      .find({ product: { $in: ['connect', 'bundle'] } })
      .select('name tier')
      .lean<Array<{ _id: Types.ObjectId; name: string; tier: string }>>()
      .exec();
    if (plans.length === 0) return empty;

    const planMap = new Map(plans.map((p) => [String(p._id), p]));
    const planIds = plans.map((p) => p._id);

    const rows = await this.paymentModel.aggregate<{
      _id: Types.ObjectId;
      grossPaise: number;
      refundedPaise: number;
      payments: number;
    }>([
      {
        $match: {
          planId: { $in: planIds },
          status: { $in: ['captured', 'partially_refunded'] },
        },
      },
      {
        $group: {
          _id: '$planId',
          grossPaise: { $sum: '$totalPaise' },
          // Inner $sum collapses each doc's refunds array; outer $sum accumulates.
          refundedPaise: { $sum: { $sum: '$refunds.amountPaise' } },
          payments: { $sum: 1 },
        },
      },
    ]);

    const byPlan: ConnectPlanRevenueRow[] = rows
      .map((r) => {
        const plan = planMap.get(String(r._id));
        const gross = r.grossPaise ?? 0;
        const refunded = r.refundedPaise ?? 0;
        return {
          planId: String(r._id),
          planName: plan?.name ?? 'Unknown plan',
          tier: plan?.tier ?? '',
          grossPaise: gross,
          refundedPaise: refunded,
          netPaise: gross - refunded,
          payments: r.payments ?? 0,
        };
      })
      .sort((a, b) => b.netPaise - a.netPaise);

    const totals = byPlan.reduce(
      (acc, r) => ({
        gross: acc.gross + r.grossPaise,
        refunded: acc.refunded + r.refundedPaise,
        payments: acc.payments + r.payments,
      }),
      { gross: 0, refunded: 0, payments: 0 },
    );

    return {
      subscription: {
        grossPaise: totals.gross,
        refundedPaise: totals.refunded,
        netPaise: totals.gross - totals.refunded,
        payments: totals.payments,
        byPlan,
      },
    };
  }
}
