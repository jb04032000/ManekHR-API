import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PlatformCreditPool } from '../schemas/platform-credit-pool.schema';
import { PlatformCreditLedger } from '../schemas/platform-credit-ledger.schema';
import { SmsService } from '../sms.service';

/**
 * Wave 8.2 — admin-only marketing campaign dispatcher.
 *
 * Decoupled from customer reminder sends:
 *   - Customer reminders (default `creditSource='customer'`) consume the
 *     workspace owner's subscription credits.
 *   - Marketing campaign sends (this service) consume the platform-side
 *     `PlatformCreditPool`. Admin manually tops up the pool after paying
 *     MSG91/AiSensy out-of-band.
 *
 * Same MSG91 wallet pre-flight + DLT compliance applies — only the credit
 * ledger differs. We never bypass the provider's own balance check.
 */
@Injectable()
export class MarketingDispatchService {
  private readonly logger = new Logger(MarketingDispatchService.name);

  constructor(
    @InjectModel(PlatformCreditPool.name)
    private readonly poolModel: Model<PlatformCreditPool>,
    @InjectModel(PlatformCreditLedger.name)
    private readonly ledgerModel: Model<PlatformCreditLedger>,
    private readonly smsService: SmsService,
  ) {}

  /**
   * Get current pool balance for a channel. Lazy-creates the pool row at
   * 0 balance on first read so admin UI always has something to render.
   */
  async getPool(channel: 'sms' | 'whatsapp'): Promise<PlatformCreditPool> {
    return this.poolModel.findOneAndUpdate(
      { channel },
      { $setOnInsert: { channel, balance: 0 } },
      { upsert: true, new: true },
    );
  }

  async getBothPools(): Promise<{ sms: number; whatsapp: number }> {
    const [sms, wa] = await Promise.all([
      this.getPool('sms'),
      this.getPool('whatsapp'),
    ]);
    return { sms: sms.balance, whatsapp: wa.balance };
  }

  /**
   * Top-up — admin records that they paid MSG91/AiSensy and adds N credits
   * to the marketing pool. Append ledger row.
   */
  async topUpPool(args: {
    channel: 'sms' | 'whatsapp';
    credits: number;
    adminId: string;
    ref?: string;
    note?: string;
  }): Promise<{ balance: number }> {
    if (!Number.isInteger(args.credits) || args.credits <= 0) {
      throw new BadRequestException('credits must be a positive integer');
    }
    const updated = await this.poolModel.findOneAndUpdate(
      { channel: args.channel },
      {
        $inc: { balance: args.credits },
        $set: { lastTopUpAt: new Date() },
        $setOnInsert: { channel: args.channel },
      },
      { upsert: true, new: true },
    );
    await this.ledgerModel.create({
      channel: args.channel,
      type: 'topup',
      amount: args.credits,
      balanceAfter: updated.balance,
      recordedBy: new Types.ObjectId(args.adminId),
      ref: args.ref,
      note: args.note ?? `Admin manual top-up`,
    });
    this.logger.log(
      `marketing pool topup: ${args.channel} +${args.credits} → ${updated.balance} (admin=${args.adminId})`,
    );
    return { balance: updated.balance };
  }

  /**
   * Recent ledger rows for the admin dashboard activity feed.
   */
  async listLedger(channel?: 'sms' | 'whatsapp', limit = 50) {
    const filter: Record<string, unknown> = {};
    if (channel) filter.channel = channel;
    return this.ledgerModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .populate('recordedBy', 'name email')
      .lean();
  }

  /**
   * Wave 8.2 minimal-scope bulk send. Admin pastes recipient phones (any
   * format), picks an MSG91 DLT template id, optional template vars common
   * to all recipients. Each recipient consumes from the marketing pool.
   *
   * Per-recipient failures are isolated (best-effort fanout). Returns
   * counts for the admin UI summary.
   */
  async sendBulkSms(args: {
    workspaceId: string;
    templateId: string;
    senderId?: string;
    recipients: string[];
    vars?: Record<string, string>;
    adminId: string;
    note?: string;
  }): Promise<{ attempted: number; sent: number; failed: number; skipped: number; campaignId: string }> {
    if (!args.recipients?.length) {
      throw new BadRequestException('recipients[] is required');
    }
    if (!args.templateId) {
      throw new BadRequestException('templateId is required');
    }

    const campaignId = new Types.ObjectId();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const mobile of args.recipients) {
      try {
        const res = await this.smsService.sendDltSms({
          workspaceId: args.workspaceId,
          mobile,
          templateId: args.templateId,
          senderId: args.senderId,
          vars: args.vars,
          creditSource: 'marketing_pool',
          entityRef: { id: campaignId, type: 'MarketingCampaign' },
        });
        if (res.status === 'sent') sent++;
        else if (res.status === 'skipped') skipped++;
        else failed++;
      } catch (err: any) {
        this.logger.warn(
          `marketing send failed mobile=${mobile.slice(-4)}: ${err?.message}`,
        );
        failed++;
      }
    }

    this.logger.log(
      `marketing campaign ${campaignId}: attempted=${args.recipients.length} sent=${sent} failed=${failed} skipped=${skipped}`,
    );
    return {
      attempted: args.recipients.length,
      sent,
      failed,
      skipped,
      campaignId: String(campaignId),
    };
  }
}
