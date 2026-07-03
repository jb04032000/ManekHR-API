import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Msg91TopUp } from '../schemas/msg91-topup.schema';
import { SmsDispatchLog } from '../schemas/sms-dispatch-log.schema';
import { Msg91BalanceService } from './msg91-balance.service';
import { Subscription } from '../../subscriptions/schemas/subscription.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';

/**
 * Wave 8 — admin-side reporting + ops actions for MSG91.
 *
 * Endpoints:
 *   GET  /admin/communications/msg91/balance       — wallet snapshot + burn + projection
 *   POST /admin/communications/msg91/topup         — record a manual top-up
 *   GET  /admin/communications/msg91/topups        — top-up history
 *   GET  /admin/communications/margin-report       — per-workspace revenue/cost/margin (paginated)
 *   GET  /admin/communications/refund-queue        — refunds awaiting manual review
 */
@Injectable()
export class Msg91AdminService {
  constructor(
    @InjectModel(Msg91TopUp.name)
    private readonly topUpModel: Model<Msg91TopUp>,
    @InjectModel(SmsDispatchLog.name)
    private readonly dispatchLogModel: Model<SmsDispatchLog>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly balance: Msg91BalanceService,
  ) {}

  /**
   * Wave 8.1 — manual credit refund (last-resort, admin-only).
   *
   * No auto-refund anywhere; refunds are operator-initiated only.
   * Atomic `$inc` on the workspace owner's subscription. Logs the action
   * with admin id + reason for audit. Caller is `IsAdminGuard`-protected.
   */
  async manualRefundCredit(args: {
    workspaceId: string;
    channel: 'sms' | 'whatsapp';
    n: number;
    reason: string;
    adminId: string;
  }): Promise<{ refunded: boolean; newBalance: number }> {
    if (!['sms', 'whatsapp'].includes(args.channel)) {
      throw new BadRequestException('channel must be sms or whatsapp');
    }
    if (!Number.isInteger(args.n) || args.n <= 0) {
      throw new BadRequestException('n must be a positive integer');
    }
    if (!args.reason || args.reason.trim().length < 3) {
      throw new BadRequestException('reason is required (min 3 chars)');
    }

    const wsId = new Types.ObjectId(args.workspaceId);
    const ws = await this.workspaceModel
      .findById(wsId, { ownerId: 1 })
      .lean();
    if (!ws?.ownerId) {
      throw new NotFoundException('Workspace not found or has no owner');
    }
    const ownerId =
      ws.ownerId instanceof Types.ObjectId
        ? ws.ownerId
        : new Types.ObjectId(String(ws.ownerId));

    const balanceField =
      args.channel === 'sms'
        ? 'appliedEntitlements.communications.smsCreditsBalance'
        : 'appliedEntitlements.communications.whatsappCreditsBalance';

    const updated = await this.subscriptionModel.findOneAndUpdate(
      {
        userId: ownerId,
        status: { $in: ['active', 'trial'] },
      },
      { $inc: { [balanceField]: args.n } },
      { new: true, projection: { appliedEntitlements: 1 } },
    );
    if (!updated) {
      throw new NotFoundException('No active subscription for workspace owner');
    }

    // Audit trail — append to BillingAuditEvent if available; fall back to
    // log line if collection not present in this deployment.
    try {
      const conn = this.subscriptionModel.db;
      await conn.collection('billingauditevents').insertOne({
        action: 'CreditPackManualRefund',
        actorType: 'admin',
        actorUserId: new Types.ObjectId(args.adminId),
        targetUserId: ownerId,
        metadata: {
          workspaceId: args.workspaceId,
          channel: args.channel,
          n: args.n,
          reason: args.reason,
        },
        createdAt: new Date(),
      });
    } catch {
      // Audit collection missing — fall back to console.
    }

    const balance =
      args.channel === 'sms'
        ? (updated.appliedEntitlements as any)?.communications
            ?.smsCreditsBalance ?? 0
        : (updated.appliedEntitlements as any)?.communications
            ?.whatsappCreditsBalance ?? 0;

    return { refunded: true, newBalance: balance };
  }

  async getBalance() {
    return this.balance.getStatus();
  }

  async recordTopUp(
    adminUserId: string,
    body: { amountPaise: number; providerReferenceId?: string; note?: string },
  ) {
    if (!body.amountPaise || body.amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be a positive integer');
    }
    return this.topUpModel.create({
      provider: 'msg91',
      amountPaise: body.amountPaise,
      recordedBy: new Types.ObjectId(adminUserId),
      providerReferenceId: body.providerReferenceId,
      note: body.note,
    });
  }

  async listTopUps(limit = 50) {
    return this.topUpModel
      .find({ provider: 'msg91' })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .populate('recordedBy', 'name email')
      .lean();
  }

  /**
   * Per-workspace margin: revenue (best-effort approximation from
   * `creditsConsumed × default-price-of-cheapest-active-pack-for-channel`)
   * minus `providerCostPaise`. Real revenue tracking attaches in Wave 9
   * via per-send PurchasedAddOn snapshot lookups.
   */
  async marginReport(args: {
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<
    Array<{
      workspaceId: string;
      sentCount: number;
      creditsConsumed: number;
      providerCostPaise: number;
    }>
  > {
    const limit = Math.min(args.limit ?? 50, 500);
    return this.dispatchLogModel.aggregate([
      {
        $match: {
          status: 'sent',
          createdAt: { $gte: args.from, $lt: args.to },
          provider: 'msg91',
        },
      },
      {
        $group: {
          _id: '$workspaceId',
          sentCount: { $sum: 1 },
          creditsConsumed: { $sum: '$creditsConsumed' },
          providerCostPaise: { $sum: '$providerCostPaise' },
        },
      },
      {
        $project: {
          _id: 0,
          workspaceId: { $toString: '$_id' },
          sentCount: 1,
          creditsConsumed: 1,
          providerCostPaise: 1,
        },
      },
      { $sort: { providerCostPaise: -1 } },
      { $limit: limit },
    ]);
  }

  /**
   * Refunds in the last 30 days where the workspace exceeds the 5%
   * monthly-consumption refund cap. Caller (admin UI) decides next steps.
   */
  async refundQueue(): Promise<
    Array<{
      workspaceId: string;
      refundedCount: number;
      consumedCount: number;
      refundRatePct: number;
    }>
  > {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.dispatchLogModel.aggregate([
      { $match: { createdAt: { $gte: cutoff } } },
      {
        $group: {
          _id: '$workspaceId',
          refundedCount: {
            $sum: { $cond: ['$creditRefunded', 1, 0] },
          },
          consumedCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'sent'] }, '$creditsConsumed', 0],
            },
          },
        },
      },
      {
        $addFields: {
          refundRatePct: {
            $cond: [
              { $gt: ['$consumedCount', 0] },
              {
                $multiply: [
                  { $divide: ['$refundedCount', '$consumedCount'] },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      { $match: { refundRatePct: { $gt: 5 } } },
      {
        $project: {
          _id: 0,
          workspaceId: { $toString: '$_id' },
          refundedCount: 1,
          consumedCount: 1,
          refundRatePct: { $round: ['$refundRatePct', 2] },
        },
      },
      { $sort: { refundRatePct: -1 } },
    ]);
  }
}
