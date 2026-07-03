import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  ConnectCreditDrop,
  type ConnectCreditDropDocument,
} from '../schemas/connect-credit-drop.schema';
import { Subscription } from '../../../subscriptions/schemas/subscription.schema';
import { WalletService } from '../../ads/services/wallet.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import type { CreateCreditDropDto } from '../dto/create-credit-drop.dto';

/**
 * ManekHR Connect Marketplace -- promotions / sales (Phase M3.2).
 *
 * The one new money primitive for promotions: a free boost-credit drop. Plan
 * discounts, intro offers, and scheduled sale windows are all handled by the
 * existing coupon engine (Connect-scoped coupons), so they need no new service
 * here.
 *
 * A drop grants `amountPerUser` credits to every resolved recipient via the
 * shipped WalletService.grant -- the SEPARATE, optionally-expiring grant bucket
 * (never purchased balance). Per-user grants are idempotent on
 * `promo-drop-<dropId>-<userId>`, so a re-run of the same drop never double-
 * credits, while two distinct drops to the same seller both apply.
 *
 * Person-centric throughout: recipients are resolved by Connect subscription
 * (`product` in connect | bundle) or an explicit user list -- never a workspace.
 */
@Injectable()
export class ConnectPromotionService {
  private readonly logger = new Logger(ConnectPromotionService.name);

  constructor(
    @InjectModel(ConnectCreditDrop.name)
    private readonly dropModel: Model<ConnectCreditDropDocument>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /** Recent credit-drop campaigns, newest first (admin history). */
  async listDrops(): Promise<ConnectCreditDrop[]> {
    return this.dropModel
      .find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<ConnectCreditDrop[]>()
      .exec();
  }

  /**
   * Run a credit drop: resolve recipients, record the campaign, grant credits
   * to each recipient idempotently, then stamp the totals.
   */
  async createDrop(
    adminUserId: string,
    dto: CreateCreditDropDto,
  ): Promise<ConnectCreditDropDocument> {
    const recipientIds = await this.resolveRecipients(dto);
    if (recipientIds.length === 0) {
      throw new BadRequestException('No recipients matched the target');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    // Record the campaign first so its id keys the per-user grant idempotency.
    const drop = await this.dropModel.create({
      amountPerUser: dto.amountPerUser,
      note: dto.note,
      expiresAt,
      targetMode: dto.targetMode,
      planId:
        dto.targetMode === 'subscribers' && dto.planId ? new Types.ObjectId(dto.planId) : null,
      targetUserIds:
        dto.targetMode === 'users' ? recipientIds.map((id) => new Types.ObjectId(id)) : [],
      recipientCount: 0,
      totalCreditsGranted: 0,
      createdBy: new Types.ObjectId(adminUserId),
    });

    const dropId = String(drop._id);
    let granted = 0;
    for (const userId of recipientIds) {
      try {
        await this.wallet.grant(userId, dto.amountPerUser, {
          idempotencyKey: `promo-drop-${dropId}-${userId}`,
          ...(expiresAt ? { expiresAt } : {}),
        });
        granted += 1;
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(`Credit drop ${dropId} grant failed for user=${userId}: ${err.message}`);
      }
    }

    drop.recipientCount = granted;
    drop.totalCreditsGranted = granted * dto.amountPerUser;
    await drop.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'ConnectCreditDrop',
      entityId: dropId,
      action: 'credit_drop_created',
      actorId: adminUserId,
      meta: {
        amountPerUser: dto.amountPerUser,
        recipientCount: granted,
        totalCreditsGranted: drop.totalCreditsGranted,
        targetMode: dto.targetMode,
        ...(dto.planId ? { planId: dto.planId } : {}),
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      },
    });
    this.posthog?.capture({
      distinctId: adminUserId,
      event: 'connect.credit_drop_created',
      properties: {
        dropId,
        amountPerUser: dto.amountPerUser,
        recipientCount: granted,
        targetMode: dto.targetMode,
      },
    });

    return drop;
  }

  /**
   * Resolve the drop's recipient user ids (deduped).
   *  - `users`: the explicit list (must be non-empty).
   *  - `subscribers`: every active Connect / bundle subscriber, optionally
   *    narrowed to one plan.
   */
  private async resolveRecipients(dto: CreateCreditDropDto): Promise<string[]> {
    if (dto.targetMode === 'users') {
      const ids = dto.userIds ?? [];
      if (ids.length === 0) {
        throw new BadRequestException('Select at least one user for a user-targeted drop');
      }
      return [...new Set(ids.map((id) => String(id)))];
    }

    const query: FilterQuery<Subscription> = {
      status: 'active',
      product: { $in: ['connect', 'bundle'] },
    };
    if (dto.planId) {
      query.planId = new Types.ObjectId(dto.planId);
    }
    const subs = await this.subscriptionModel
      .find(query)
      .select('userId')
      .lean<Array<{ userId: Types.ObjectId }>>()
      .exec();
    return [...new Set(subs.map((s) => String(s.userId)))];
  }
}
