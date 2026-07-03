import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import { env } from '../../config/env';
import {
  AddOnDefinition,
  AddOnDefinitionDocument,
  AddOnType,
  AddOnBillingCycle,
} from './schemas/add-on-definition.schema';
import {
  PurchasedAddOn,
  PurchasedAddOnDocument,
  PurchasedAddOnStatus,
  PurchasedAddOnSource,
} from './schemas/purchased-add-on.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { Plan, PlanEntitlements } from '../subscriptions/schemas/plan.schema';
import { User } from '../users/schemas/user.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmsService } from '../sms/sms.service';
import { mergeEntitlements } from './utils/entitlement-merge.util';
import { PurchaseAddOnDto, CancelAddOnDto } from './dto/purchase-add-on.dto';
import {
  CreateAddOnDefinitionDto,
  UpdateAddOnDefinitionDto,
} from './dto/create-add-on-definition.dto';
import { AdminAssignAddOnDto } from './dto/admin-assign-add-on.dto';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';

export enum AddOnErrorCode {
  NO_ACTIVE_SUBSCRIPTION = 'NO_ACTIVE_SUBSCRIPTION',
  SUBSCRIPTION_CANCELLED = 'SUBSCRIPTION_CANCELLED',
  ADDON_INACTIVE = 'ADDON_INACTIVE',
  TIER_NOT_ELIGIBLE = 'TIER_NOT_ELIGIBLE',
  STACK_LIMIT_REACHED = 'STACK_LIMIT_REACHED',
  MODULE_ALREADY_INCLUDED = 'MODULE_ALREADY_INCLUDED',
  SUBFEATURE_ALREADY_COVERED = 'SUBFEATURE_ALREADY_COVERED',
  TOO_CLOSE_TO_RENEWAL = 'TOO_CLOSE_TO_RENEWAL',
}

type CommsEntitlement = {
  smsCreditsBalance?: number;
  whatsappCreditsBalance?: number;
  autoRechargeEnabled?: boolean;
  autoRechargeThresholdSms?: number;
  autoRechargeThresholdWhatsapp?: number;
  autoRechargeSmsPackSlug?: string;
  autoRechargeWhatsappPackSlug?: string;
  lastLowBalanceAlertAt?: string | Date;
  [k: string]: unknown;
};
type EntitlementsWithComms = { communications?: CommsEntitlement };

@Injectable()
export class AddOnsService {
  private readonly logger = new Logger(AddOnsService.name);

  constructor(
    @InjectModel(AddOnDefinition.name)
    private addOnDefinitionModel: Model<AddOnDefinitionDocument>,
    @InjectModel(PurchasedAddOn.name)
    private purchasedAddOnModel: Model<PurchasedAddOnDocument>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private planModel: Model<Plan>,
    // Wave 5 credit-pack low-balance alert dispatch.
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly singleFlight: SingleFlightService,
    // SmsService comes from @Global SmsModule. Optional — boot still works
    // when SMS isn't wired (tests, future split deployments).
    @Optional()
    private readonly smsService?: SmsService,
  ) {}

  async getAvailableAddOns(userId: string): Promise<AddOnDefinition[]> {
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    // Wave 8.2 — when there's no active subscription, still surface
    // CREDIT_PACK add-ons. They're universally applicable (every tier
    // including 'free' is in `applicableTiers`) so a fresh signup or a
    // canceled customer can still browse + buy SMS / WhatsApp packs.
    // Other add-on types (QUOTA / MODULE / SUBFEATURE) stay hidden
    // because they need a real subscription to attach to.
    if (!subscription) {
      return this.addOnDefinitionModel
        .find({
          isActive: true,
          type: AddOnType.CREDIT_PACK,
        })
        .sort({ displayOrder: 1 })
        .lean();
    }

    const plan = subscription.planId as unknown as Plan;
    const userTier = plan?.tier;

    const query: Record<string, unknown> = { isActive: true };
    if (userTier) {
      query.$or = [
        { applicableTiers: { $size: 0 } },
        { applicableTiers: userTier },
        { applicableTiers: { $exists: false } },
      ];
    }

    return this.addOnDefinitionModel.find(query).sort({ displayOrder: 1 }).lean();
  }

  async getMyAddOns(userId: string): Promise<PurchasedAddOn[]> {
    return this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .populate('addOnDefinitionId')
      .lean();
  }

  async validatePurchase(
    userId: string,
    dto: PurchaseAddOnDto,
  ): Promise<{
    valid: boolean;
    error?: { code: AddOnErrorCode; message: string };
  }> {
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    if (!subscription) {
      return {
        valid: false,
        error: {
          code: AddOnErrorCode.NO_ACTIVE_SUBSCRIPTION,
          message: 'You need an active subscription to purchase add-ons',
        },
      };
    }

    if (subscription.status === 'cancelled') {
      return {
        valid: false,
        error: {
          code: AddOnErrorCode.SUBSCRIPTION_CANCELLED,
          message: 'Cannot purchase add-ons during cancellation grace period. Resubscribe first.',
        },
      };
    }

    const addOnDefinition = await this.addOnDefinitionModel.findById(dto.addOnDefinitionId).lean();
    if (!addOnDefinition || !addOnDefinition.isActive) {
      return {
        valid: false,
        error: {
          code: AddOnErrorCode.ADDON_INACTIVE,
          message: 'This add-on is no longer available',
        },
      };
    }

    const plan = subscription.planId as unknown as Plan;
    const userTier = plan?.tier;

    if (
      addOnDefinition.applicableTiers?.length > 0 &&
      userTier &&
      !addOnDefinition.applicableTiers.includes(userTier)
    ) {
      return {
        valid: false,
        error: {
          code: AddOnErrorCode.TIER_NOT_ELIGIBLE,
          message: 'This add-on is not available for your current plan tier',
        },
      };
    }

    const activeAddOns = await this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        addOnDefinitionId: new Types.ObjectId(dto.addOnDefinitionId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .lean();

    const currentQuantity = activeAddOns.reduce((sum, pa) => sum + (pa.quantity ?? 1), 0);
    const requestedQuantity = dto.quantity ?? 1;

    // If stackable and maxStack is -1 (unlimited), always allow
    // If stackable and maxStack > 0, check the limit
    // If not stackable and already has one, block
    if (addOnDefinition.stackable) {
      if (
        addOnDefinition.maxStack > 0 &&
        currentQuantity + requestedQuantity > addOnDefinition.maxStack
      ) {
        return {
          valid: false,
          error: {
            code: AddOnErrorCode.STACK_LIMIT_REACHED,
            message: `You already have the maximum allowed (${addOnDefinition.maxStack}) of this add-on`,
          },
        };
      }
      // If stackable with maxStack === -1 or has room, allow
    } else if (activeAddOns.length > 0) {
      return {
        valid: false,
        error: {
          code: AddOnErrorCode.STACK_LIMIT_REACHED,
          message: 'You already have this add-on',
        },
      };
    }

    if (
      addOnDefinition.type === AddOnType.MODULE &&
      addOnDefinition.entitlementDelta.targetModule
    ) {
      const planModules = plan?.entitlements?.modules ?? [];
      if (planModules.includes(addOnDefinition.entitlementDelta.targetModule)) {
        return {
          valid: false,
          error: {
            code: AddOnErrorCode.MODULE_ALREADY_INCLUDED,
            message: `Your plan already includes the ${addOnDefinition.entitlementDelta.targetModule} module`,
          },
        };
      }
    }

    if (addOnDefinition.type === AddOnType.SUBFEATURE) {
      const planModuleAccess = plan?.entitlements?.moduleAccess ?? [];
      const targetModule = addOnDefinition.entitlementDelta.targetSubFeatureModule;
      const targetKey = addOnDefinition.entitlementDelta.targetSubFeatureKey;
      const targetAccess = addOnDefinition.entitlementDelta.targetSubFeatureAccess;

      type ModuleAccessLike = {
        module: string;
        subFeatures?: Array<{ key: string; access: 'locked' | 'limited' | 'full' }>;
      };
      const moduleAccess = (planModuleAccess as ModuleAccessLike[]).find(
        (m) => m.module === String(targetModule),
      );
      if (moduleAccess) {
        const sf = moduleAccess.subFeatures?.find((s) => s.key === targetKey);
        if (sf) {
          const accessOrder = { locked: 0, limited: 1, full: 2 };
          if (
            (accessOrder[sf.access] ?? 0) >=
            (accessOrder[targetAccess as keyof typeof accessOrder] ?? 0)
          ) {
            return {
              valid: false,
              error: {
                code: AddOnErrorCode.SUBFEATURE_ALREADY_COVERED,
                message: `Your plan already provides ${sf.access} access to ${targetKey}`,
              },
            };
          }
        }
      }
    }

    if (addOnDefinition.minDaysBeforeRenewal > 0 && subscription.currentPeriodEnd) {
      const now = new Date();
      const daysUntilRenewal = Math.ceil(
        (subscription.currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysUntilRenewal < addOnDefinition.minDaysBeforeRenewal) {
        return {
          valid: false,
          error: {
            code: AddOnErrorCode.TOO_CLOSE_TO_RENEWAL,
            message: `Your plan renews in ${daysUntilRenewal} days. Consider upgrading your plan instead.`,
          },
        };
      }
    }

    return { valid: true };
  }

  async previewPurchase(userId: string, dto: PurchaseAddOnDto): Promise<any> {
    this.logger.log(`previewPurchase called: userId=${userId}, dto=${JSON.stringify(dto)}`);

    const validation = await this.validatePurchase(userId, dto);
    this.logger.log(
      `previewPurchase validation: valid=${validation.valid}, error=${JSON.stringify(validation.error)}`,
    );

    if (!validation.valid) {
      return { error: validation.error, valid: false };
    }

    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    const addOnDefinition = await this.addOnDefinitionModel.findById(dto.addOnDefinitionId).lean();
    if (!addOnDefinition) {
      return {
        error: { code: 'ADDON_NOT_FOUND', message: 'Add-on not found' },
        valid: false,
      };
    }

    const plan = subscription?.planId as unknown as Plan;
    const billingCycle = dto.billingCycle ?? addOnDefinition.defaultBillingCycle;
    const quantity = dto.quantity ?? 1;

    let fullPrice = 0;
    switch (billingCycle) {
      case AddOnBillingCycle.MONTHLY:
        fullPrice = addOnDefinition.monthlyPrice * quantity;
        break;
      case AddOnBillingCycle.YEARLY:
        fullPrice = addOnDefinition.yearlyPrice * quantity;
        break;
      case AddOnBillingCycle.LIFETIME:
        fullPrice = addOnDefinition.lifetimePrice * quantity;
        break;
      case AddOnBillingCycle.SUBSCRIPTION:
        fullPrice = 0;
        break;
    }

    let proratedPrice = 0;
    let daysUntilRenewal = 0;
    const warnings: string[] = [];

    if (
      subscription?.currentPeriodEnd &&
      billingCycle !== AddOnBillingCycle.SUBSCRIPTION &&
      addOnDefinition.allowProratedBilling
    ) {
      const now = new Date();
      daysUntilRenewal = Math.ceil(
        (subscription.currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysUntilRenewal > 0) {
        const daysInMonth = 30;
        proratedPrice = (fullPrice / daysInMonth) * daysUntilRenewal;
        proratedPrice = Math.round(proratedPrice * 100) / 100;
      }
    }

    if (subscription?.currentPeriodEnd) {
      const now = new Date();
      daysUntilRenewal = Math.ceil(
        (subscription.currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysUntilRenewal <= 7 && daysUntilRenewal > 0) {
        warnings.push(`Your plan renews in ${daysUntilRenewal} days`);
      }
    }

    const activeAddOns = await this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .lean();

    const currentDeltas = activeAddOns.map((pa) => ({
      delta: pa.entitlementDelta,
      quantity: pa.quantity ?? 1,
    }));

    const baseEntitlements = subscription?.appliedEntitlements ??
      plan?.entitlements ?? {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
        modules: [],
        features: {},
        moduleAccess: [],
        platformAccess: 'both',
        maxSessionsPerPlatform: 3,
        maxSessionsTotal: 5,
      };

    const beforeEntitlements = mergeEntitlements(baseEntitlements, currentDeltas);

    const newDelta = {
      delta: {
        ...addOnDefinition.entitlementDelta,
        extraWorkspaces: (addOnDefinition.entitlementDelta.extraWorkspaces ?? 0) * quantity,
        extraMembersPerWorkspace:
          (addOnDefinition.entitlementDelta.extraMembersPerWorkspace ?? 0) * quantity,
        extraTotalMembers: (addOnDefinition.entitlementDelta.extraTotalMembers ?? 0) * quantity,
        extraSessionsPerPlatform:
          (addOnDefinition.entitlementDelta.extraSessionsPerPlatform ?? 0) * quantity,
        extraSessionsTotal: (addOnDefinition.entitlementDelta.extraSessionsTotal ?? 0) * quantity,
      },
      quantity: 1,
    };

    const afterEntitlements = mergeEntitlements(baseEntitlements, [...currentDeltas, newDelta]);

    return {
      valid: true,
      proratedPrice,
      fullPrice,
      daysUntilRenewal,
      billingCycle,
      entitlementPreview: {
        before: beforeEntitlements,
        after: afterEntitlements,
      },
      warnings,
    };
  }

  async purchaseAddOn(
    userId: string,
    dto: PurchaseAddOnDto,
  ): Promise<{
    purchasedAddOn: PurchasedAddOn;
    appliedEntitlements: PlanEntitlements;
  }> {
    this.logger.log(`purchaseAddOn called: userId=${userId}, dto=${JSON.stringify(dto)}`);

    const validation = await this.validatePurchase(userId, dto);
    this.logger.log(
      `purchaseAddOn validation: valid=${validation.valid}, error=${JSON.stringify(validation.error)}`,
    );

    if (!validation.valid) {
      throw new BadRequestException(validation.error.message);
    }

    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    const addOnDefinition = await this.addOnDefinitionModel.findById(dto.addOnDefinitionId).lean();
    if (!addOnDefinition) {
      throw new NotFoundException('Add-on definition not found');
    }

    // Wave 7 — credit-pack purchases REQUIRE the billing flow. The legacy
    // free-mint path (no Razorpay charge) is closed. Cron auto-recharge
    // and admin assign call `applyCreditPackInternal()` directly to skip
    // payment when origin is system or admin.
    if (addOnDefinition.type === AddOnType.CREDIT_PACK) {
      throw new BadRequestException(
        'Credit packs must be purchased via /add-ons/credit-pack/order',
      );
    }

    const billingCycle = dto.billingCycle ?? addOnDefinition.defaultBillingCycle;
    const quantity = dto.quantity ?? 1;

    let expiresAt: Date | undefined;
    if (billingCycle === AddOnBillingCycle.MONTHLY) {
      expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else if (billingCycle === AddOnBillingCycle.YEARLY) {
      expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else if (billingCycle === AddOnBillingCycle.LIFETIME) {
      expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    }

    let proratedAmount = 0;
    if (
      subscription?.currentPeriodEnd &&
      billingCycle !== AddOnBillingCycle.SUBSCRIPTION &&
      addOnDefinition.allowProratedBilling
    ) {
      const now = new Date();
      const daysUntilRenewal = Math.ceil(
        (subscription.currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysUntilRenewal > 0) {
        const basePrice =
          billingCycle === AddOnBillingCycle.MONTHLY
            ? addOnDefinition.monthlyPrice
            : addOnDefinition.yearlyPrice;
        proratedAmount = ((basePrice * quantity) / 30) * daysUntilRenewal;
        proratedAmount = Math.round(proratedAmount * 100) / 100;
      }
    }

    const purchasedAddOn = await this.purchasedAddOnModel.create({
      userId: new Types.ObjectId(userId),
      subscriptionId: subscription?._id,
      addOnDefinitionId: addOnDefinition._id,
      status: PurchasedAddOnStatus.ACTIVE,
      source: PurchasedAddOnSource.SELF,
      entitlementDelta: addOnDefinition.entitlementDelta,
      billingCycle,
      quantity,
      activatedAt: new Date(),
      expiresAt,
      proratedAmount,
    });

    // CREDIT_PACK is filtered out above and routed through the billing
    // flow → applyCreditPackInternal(). Other types follow the standard
    // recompute (entitlement deltas merged in).
    await this.recalculateAppliedEntitlements(userId);

    const updatedSubscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();

    return {
      purchasedAddOn,
      appliedEntitlements: updatedSubscription?.appliedEntitlements,
    };
  }

  async cancelAddOn(
    userId: string,
    addOnId: string,
    _dto: CancelAddOnDto,
  ): Promise<{ appliedEntitlements: PlanEntitlements }> {
    const purchasedAddOn = await this.purchasedAddOnModel.findById(addOnId).lean();
    if (!purchasedAddOn) {
      throw new NotFoundException('Purchased add-on not found');
    }

    if (purchasedAddOn.userId.toString() !== userId) {
      throw new ForbiddenException('Not authorized to cancel this add-on');
    }

    if (purchasedAddOn.status !== PurchasedAddOnStatus.ACTIVE) {
      throw new BadRequestException('Add-on is not active');
    }

    await this.purchasedAddOnModel.findByIdAndUpdate(addOnId, {
      $set: {
        status: PurchasedAddOnStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    await this.recalculateAppliedEntitlements(userId);

    const updatedSubscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();

    return {
      appliedEntitlements: updatedSubscription?.appliedEntitlements,
    };
  }

  async cancelAllUserAddOns(userId: string, note?: string): Promise<void> {
    this.logger.log(`cancelAllUserAddOns called for userId=${userId}`);

    const activeAddOns = await this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .lean();

    this.logger.log(`cancelAllUserAddOns: Found ${activeAddOns.length} active add-ons`);

    if (activeAddOns.length === 0) {
      return;
    }

    // Cancel all active add-ons
    await this.purchasedAddOnModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        status: PurchasedAddOnStatus.ACTIVE,
      },
      {
        $set: {
          status: PurchasedAddOnStatus.CANCELLED,
          cancelledAt: new Date(),
          note: note || 'Cancelled due to subscription revocation',
        },
      },
    );

    this.logger.log(`cancelAllUserAddOns: Cancelled ${activeAddOns.length} add-ons`);

    // Recalculate entitlements
    await this.recalculateAppliedEntitlements(userId);
  }

  async recalculateAppliedEntitlements(userId: string): Promise<void> {
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    if (!subscription) {
      this.logger.log(`recalculateAppliedEntitlements: No subscription found for user ${userId}`);
      return;
    }

    this.logger.log(
      `recalculateAppliedEntitlements: subscription.adminEntitlementOverride = ${subscription.adminEntitlementOverride}`,
    );
    this.logger.log(
      `recalculateAppliedEntitlements: subscription.planId = ${JSON.stringify(subscription.planId)}`,
    );
    this.logger.log(
      `recalculateAppliedEntitlements: subscription.purchasedEntitlements = ${JSON.stringify(subscription.purchasedEntitlements)}`,
    );
    this.logger.log(
      `recalculateAppliedEntitlements: subscription.appliedEntitlements = ${JSON.stringify(subscription.appliedEntitlements)}`,
    );

    if (subscription.adminEntitlementOverride) {
      this.logger.log(`Skipping recalculation for user ${userId} - admin override is set`);
      return;
    }

    const activeAddOns = await this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .lean();

    this.logger.log(
      `recalculateAppliedEntitlements: Found ${activeAddOns.length} active add-ons for user ${userId}`,
    );
    for (const pa of activeAddOns) {
      this.logger.log(
        `  Add-on delta: extraTotalMembers=${pa.entitlementDelta?.extraTotalMembers}, extraWorkspaces=${pa.entitlementDelta?.extraWorkspaces}, quantity=${pa.quantity}`,
      );
    }

    const hasActiveAddOns = activeAddOns.length > 0;

    const deltas = activeAddOns.map((pa) => ({
      delta: pa.entitlementDelta,
      quantity: pa.quantity ?? 1,
    }));

    this.logger.log(`recalculateAppliedEntitlements: deltas = ${JSON.stringify(deltas)}`);

    const plan = subscription.planId as unknown as Plan;
    this.logger.log(`recalculateAppliedEntitlements: plan = ${JSON.stringify(plan?.entitlements)}`);
    this.logger.log(
      `recalculateAppliedEntitlements: subscription.purchasedEntitlements = ${JSON.stringify(subscription.purchasedEntitlements)}`,
    );

    const baseEntitlements = subscription.purchasedEntitlements ??
      plan?.entitlements ?? {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
        modules: [],
        features: {},
        moduleAccess: [],
        platformAccess: 'both',
        maxSessionsPerPlatform: 3,
        maxSessionsTotal: 5,
      };

    this.logger.log(
      `recalculateAppliedEntitlements: baseEntitlements.maxTotalMembers=${baseEntitlements.maxTotalMembers}`,
    );

    const mergedEntitlements = mergeEntitlements(baseEntitlements, deltas);

    // Wave 4 credit-pack: preserve communications balance across recompute.
    // Balance is mutated imperatively (top-up via applyCreditPackToBalance,
    // decrement via consumeCredit) and must NOT be wiped when an unrelated
    // add-on triggers a recompute. Source from current appliedEntitlements,
    // fall back to merged defaults.
    const currentComms = (subscription.appliedEntitlements as EntitlementsWithComms | undefined)
      ?.communications;
    if (currentComms) {
      (mergedEntitlements as EntitlementsWithComms).communications = currentComms;
    }

    this.logger.log(
      `recalculateAppliedEntitlements: mergedEntitlements.maxTotalMembers=${mergedEntitlements.maxTotalMembers}`,
    );

    this.logger.log(
      `recalculateAppliedEntitlements: Updating subscription _id=${String(subscription._id)}`,
    );

    await this.subscriptionModel.findOneAndUpdate(
      { _id: subscription._id },
      {
        $set: {
          appliedEntitlements: mergedEntitlements,
          hasActiveAddOns,
        },
      },
    );

    // Verify by reading back
    const verifySub = await this.subscriptionModel.findById(subscription._id).lean();
    this.logger.log(
      `recalculateAppliedEntitlements: Verification - appliedEntitlements.maxTotalMembers=${verifySub?.appliedEntitlements?.maxTotalMembers}`,
    );

    // Verify the update was successful
    const updatedSub = await this.subscriptionModel.findById(subscription._id).lean();
    this.logger.log(
      `recalculateAppliedEntitlements: Updated subscription appliedEntitlements.maxTotalMembers = ${updatedSub?.appliedEntitlements?.maxTotalMembers}`,
    );

    this.logger.log(
      `Recalculated entitlements for user ${userId}: ${activeAddOns.length} active add-ons`,
    );
  }

  /**
   * Wave 7 — internal credit-pack activation. Mints a `PurchasedAddOn`,
   * tops up the balance, recomputes appliedEntitlements. Skips the
   * payment gate enforced by the public `purchaseAddOn()` so the billing
   * confirm flow, cron auto-recharge, and admin assign can all share one
   * activation path.
   *
   * Caller MUST pre-validate (eligibility, stack limit, payment captured
   * for self-origin) — this method blindly trusts inputs. `source` is
   * persisted on the new PurchasedAddOn so audit trails distinguish
   * self / admin / system origins.
   */
  async applyCreditPackInternal(args: {
    userId: string;
    subscriptionId: string;
    addOnDefinition: AddOnDefinition;
    quantity: number;
    source: 'self' | 'admin' | 'system';
    assignedBy?: string;
  }): Promise<PurchasedAddOn> {
    const { userId, subscriptionId, addOnDefinition, quantity, source, assignedBy } = args;
    if (addOnDefinition.type !== AddOnType.CREDIT_PACK) {
      throw new BadRequestException('applyCreditPackInternal: addOn is not a credit pack');
    }

    const billingCycle = addOnDefinition.defaultBillingCycle ?? AddOnBillingCycle.LIFETIME;
    const expiresAt = new Date();
    if (billingCycle === AddOnBillingCycle.MONTHLY) {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else if (billingCycle === AddOnBillingCycle.YEARLY) {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      // LIFETIME / SUBSCRIPTION → effectively forever for credit packs.
      expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    }

    const sourceMap: Record<string, PurchasedAddOnSource> = {
      self: PurchasedAddOnSource.SELF,
      admin: PurchasedAddOnSource.ADMIN,
      system: PurchasedAddOnSource.ADMIN,
    };

    const purchasedAddOn = await this.purchasedAddOnModel.create({
      userId: new Types.ObjectId(userId),
      subscriptionId: new Types.ObjectId(subscriptionId),
      addOnDefinitionId: addOnDefinition._id,
      status: PurchasedAddOnStatus.ACTIVE,
      source: sourceMap[source],
      assignedBy: assignedBy ? new Types.ObjectId(assignedBy) : undefined,
      entitlementDelta: addOnDefinition.entitlementDelta,
      billingCycle,
      quantity,
      activatedAt: new Date(),
      expiresAt,
      proratedAmount: 0,
      note: source === 'system' ? 'Auto-recharge (low balance)' : undefined,
    });

    await this.applyCreditPackToBalance(
      subscriptionId,
      addOnDefinition.entitlementDelta?.creditsDelta,
      quantity,
    );
    await this.recalculateAppliedEntitlements(userId);
    this.logger.log(
      `applyCreditPackInternal: user=${userId} pack=${addOnDefinition.slug} qty=${quantity} source=${source} purchased=${String(purchasedAddOn._id)}`,
    );
    return purchasedAddOn;
  }

  /**
   * Wave 4 credit-pack: top up the SMS / WhatsApp balance counters on a
   * subscription's appliedEntitlements after a CREDIT_PACK purchase activates.
   *
   * Idempotent at the call-site level (each PurchasedAddOn doc triggers ONE
   * call). Subsequent recomputes preserve the new balance via the comms-
   * preservation hook in `recalculateAppliedEntitlements`.
   */
  async applyCreditPackToBalance(
    subscriptionId: string,
    creditsDelta: { sms?: number; whatsapp?: number } | undefined,
    quantity: number,
  ): Promise<void> {
    if (!creditsDelta) return;
    const inc: Record<string, number> = {};
    const sms = (creditsDelta.sms ?? 0) * (quantity || 1);
    const wa = (creditsDelta.whatsapp ?? 0) * (quantity || 1);
    if (sms > 0) {
      inc['appliedEntitlements.communications.smsCreditsBalance'] = sms;
    }
    if (wa > 0) {
      inc['appliedEntitlements.communications.whatsappCreditsBalance'] = wa;
    }
    if (Object.keys(inc).length === 0) return;
    await this.subscriptionModel.updateOne(
      { _id: new Types.ObjectId(subscriptionId) },
      { $inc: inc },
    );
    this.logger.log(`applyCreditPackToBalance: subId=${subscriptionId} +sms=${sms} +wa=${wa}`);
  }

  /**
   * Wave 8 — one-shot Free-tier trial credit grant.
   *
   * Grants 10 SMS + 5 WhatsApp credits to the workspace owner's active
   * subscription. Gated by `appliedEntitlements.communications.lifetimeTrialGranted`
   * — flips `false → true` atomically so concurrent calls don't double-grant.
   *
   * Per-subscription, NOT per-user — multi-workspace abuse capped via
   * `workspace.ownerId` (each user has exactly one Subscription, but each
   * Subscription supports multiple workspaces). Best-effort: failures log
   * but don't propagate (caller is the workspace-create flow, must not break).
   */
  async grantTrialCreditsForWorkspace(workspaceId: string): Promise<{
    granted: boolean;
    reason?: string;
  }> {
    const TRIAL_SMS = env.trial.smsCredits;
    const TRIAL_WA = env.trial.whatsappCredits;

    try {
      // Lookup the workspace owner's subscription via the workspace doc.
      const ws = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId), { ownerId: 1 })
        .lean();
      if (!ws?.ownerId) {
        return { granted: false, reason: 'workspace_not_found' };
      }
      const ownerId =
        ws.ownerId instanceof Types.ObjectId
          ? ws.ownerId
          : new Types.ObjectId(ws.ownerId as string);

      // Atomic flip false→true with $inc balances. If a prior call already
      // flipped the flag, the precondition fails → granted=false.
      const result = await this.subscriptionModel.findOneAndUpdate(
        {
          userId: ownerId,
          status: { $in: ['active', 'trial'] },
          $or: [
            {
              'appliedEntitlements.communications.lifetimeTrialGranted': false,
            },
            {
              'appliedEntitlements.communications.lifetimeTrialGranted': {
                $exists: false,
              },
            },
          ],
        },
        {
          $set: {
            'appliedEntitlements.communications.lifetimeTrialGranted': true,
          },
          $inc: {
            'appliedEntitlements.communications.smsCreditsBalance': TRIAL_SMS,
            'appliedEntitlements.communications.whatsappCreditsBalance': TRIAL_WA,
          },
        },
        { new: true, projection: { _id: 1 } },
      );
      if (!result) {
        return { granted: false, reason: 'already_granted' };
      }
      this.logger.log(
        `grantTrialCreditsForWorkspace: ws=${workspaceId} owner=${String(ownerId)} +${TRIAL_SMS} sms +${TRIAL_WA} wa`,
      );
      return { granted: true };
    } catch (err: unknown) {
      const _msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error(`grantTrialCreditsForWorkspace failed ws=${workspaceId}: ${_msg}`);
      return { granted: false, reason: 'error' };
    }
  }

  /**
   * Wave 7 — patch auto-recharge config on the user's active subscription.
   * Only fields present in the patch are written (Mongo `$set` per key)
   * so a partial update doesn't reset other knobs to defaults.
   *
   * Caller must enforce paid-tier gating at the controller layer if
   * needed — service treats any active sub as eligible for the toggle.
   */
  async updateAutoRechargeConfig(
    userId: string,
    patch: {
      autoRechargeEnabled?: boolean;
      autoRechargeThresholdSms?: number;
      autoRechargeThresholdWhatsapp?: number;
      autoRechargeSmsPackSlug?: string;
      autoRechargeWhatsappPackSlug?: string;
    },
  ): Promise<{ communications: any }> {
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();
    if (!sub) {
      throw new BadRequestException('No active subscription');
    }

    const set: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      set[`appliedEntitlements.communications.${k}`] = v;
    }
    if (Object.keys(set).length === 0) {
      const comms =
        (sub.appliedEntitlements as EntitlementsWithComms | undefined)?.communications ?? {};
      return { communications: comms };
    }

    await this.subscriptionModel.updateOne({ _id: sub._id }, { $set: set });
    const updated = await this.subscriptionModel.findById(sub._id).lean();
    return {
      communications:
        (updated?.appliedEntitlements as EntitlementsWithComms | undefined)?.communications ?? {},
    };
  }

  /**
   * Wave 4 credit-pack: atomic decrement of one credit on a SMS / WhatsApp
   * send. Returns true if the credit was consumed, false if balance was
   * insufficient (caller must NOT send the message in that case).
   *
   * Uses Mongo's atomic `findOneAndUpdate` with a `$gte: 1` precondition to
   * avoid race conditions when bulk dispatchers send in parallel.
   */
  async consumeCredit(userId: string, channel: 'sms' | 'whatsapp'): Promise<boolean> {
    const balanceField =
      channel === 'sms'
        ? 'appliedEntitlements.communications.smsCreditsBalance'
        : 'appliedEntitlements.communications.whatsappCreditsBalance';
    const result = await this.subscriptionModel.findOneAndUpdate(
      {
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
        [balanceField]: { $gte: 1 },
      },
      { $inc: { [balanceField]: -1 } },
      { new: true },
    );
    return result !== null;
  }

  async getAddOnDefinitions(includeInactive = false): Promise<AddOnDefinition[]> {
    const filter = includeInactive ? {} : { isActive: true };
    return this.addOnDefinitionModel.find(filter).sort({ displayOrder: 1 }).lean();
  }

  async createAddOnDefinition(dto: CreateAddOnDefinitionDto): Promise<AddOnDefinition> {
    const existing = await this.addOnDefinitionModel.findOne({ slug: dto.slug }).lean();
    if (existing) {
      if (!existing.isActive) {
        throw new BadRequestException(
          `An add-on with slug "${dto.slug}" already exists but is inactive. Please use a different slug or restore the existing one.`,
        );
      }
      throw new BadRequestException(`Add-on with slug "${dto.slug}" already exists`);
    }
    return this.addOnDefinitionModel.create(dto);
  }

  async updateAddOnDefinition(id: string, dto: UpdateAddOnDefinitionDto): Promise<AddOnDefinition> {
    const addOn = await this.addOnDefinitionModel.findByIdAndUpdate(id, dto, { new: true }).lean();
    if (!addOn) {
      throw new NotFoundException('Add-on definition not found');
    }
    return addOn;
  }

  async deleteAddOnDefinition(id: string): Promise<void> {
    const result = await this.addOnDefinitionModel.findByIdAndUpdate(id, {
      isActive: false,
    });
    if (!result) {
      throw new NotFoundException('Add-on definition not found');
    }
  }

  async getUserAddOns(userId: string): Promise<PurchasedAddOn[]> {
    return this.purchasedAddOnModel
      .find({ userId: new Types.ObjectId(userId) })
      .populate('addOnDefinitionId')
      .lean();
  }

  async adminAssignAddOn(adminId: string, dto: AdminAssignAddOnDto): Promise<PurchasedAddOn> {
    this.logger.log(`=== adminAssignAddOn called ===`);
    this.logger.log(`  userId: ${dto.userId}`);
    this.logger.log(`  addOnDefinitionId: ${dto.addOnDefinitionId}`);

    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(dto.userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();

    if (!subscription) {
      throw new BadRequestException('User has no active subscription');
    }

    this.logger.log(`  subscription._id: ${String(subscription._id)}`);

    const addOnDefinition = await this.addOnDefinitionModel.findById(dto.addOnDefinitionId).lean();
    if (!addOnDefinition) {
      throw new NotFoundException('Add-on definition not found');
    }

    this.logger.log(`  addOnDefinition: ${JSON.stringify(addOnDefinition)}`);

    const billingCycle = dto.billingCycle ?? addOnDefinition.defaultBillingCycle;
    const quantity = dto.quantity ?? 1;

    let expiresAt: Date | undefined;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
    } else if (billingCycle === AddOnBillingCycle.MONTHLY) {
      expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else if (billingCycle === AddOnBillingCycle.YEARLY) {
      expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else if (billingCycle === AddOnBillingCycle.LIFETIME) {
      expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    }

    this.logger.log(
      `adminAssignAddOn: addOnDefinition.entitlementDelta = ${JSON.stringify(addOnDefinition.entitlementDelta)}`,
    );

    // Wave 7 — credit-pack admin assigns route through the shared internal
    // activation path so balance top-up + recompute happen consistently.
    if (addOnDefinition.type === AddOnType.CREDIT_PACK) {
      return this.applyCreditPackInternal({
        userId: dto.userId,
        subscriptionId: subscription._id.toString(),
        addOnDefinition,
        quantity,
        source: 'admin',
        assignedBy: adminId,
      });
    }

    const purchasedAddOn = await this.purchasedAddOnModel.create({
      userId: new Types.ObjectId(dto.userId),
      subscriptionId: subscription._id,
      addOnDefinitionId: addOnDefinition._id,
      status: PurchasedAddOnStatus.ACTIVE,
      source: PurchasedAddOnSource.ADMIN,
      assignedBy: new Types.ObjectId(adminId),
      entitlementDelta: addOnDefinition.entitlementDelta,
      billingCycle,
      quantity,
      activatedAt: new Date(),
      expiresAt,
      note: dto.note,
    });

    this.logger.log(
      `adminAssignAddOn: purchasedAddOn.entitlementDelta = ${JSON.stringify(purchasedAddOn.entitlementDelta)}`,
    );

    await this.recalculateAppliedEntitlements(dto.userId);

    return purchasedAddOn;
  }

  async adminRevokeAddOn(adminId: string, addOnId: string): Promise<void> {
    const purchasedAddOn = await this.purchasedAddOnModel.findById(addOnId).lean();
    if (!purchasedAddOn) {
      throw new NotFoundException('Purchased add-on not found');
    }

    await this.purchasedAddOnModel.findByIdAndUpdate(addOnId, {
      $set: {
        status: PurchasedAddOnStatus.CANCELLED,
        cancelledAt: new Date(),
        note: `Revoked by admin ${adminId}`,
      },
    });

    await this.recalculateAppliedEntitlements(purchasedAddOn.userId.toString());
  }

  /**
   * CRON CONTRACT - Expire add-ons
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 00:05 UTC - expire time-lapsed + parent-expired add-ons.
   * Idempotent:  YES (state) - flips ACTIVE add-ons past expiry to EXPIRED; a
   *              re-run finds none still ACTIVE+expired. Entitlement recompute is
   *              itself idempotent.
   * Reads/Writes: purchased_add_ons (status -> expired), subscriptions; recomputes
   *              applied entitlements.
   * Missed run:  Self-heals - the next day expires any newly-lapsed add-ons.
   * Owner:       add-ons
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_00_05_UTC, { timeZone: CRON_TIMEZONES.UTC })
  async processExpiredAddOns(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.EXPIRED_ADDONS, dayBucket(), () =>
      this.runProcessExpiredAddOns(),
    );
  }

  private async runProcessExpiredAddOns(): Promise<void> {
    this.logger.log('Processing expired add-ons...');
    const now = new Date();

    const expiredByTime = await this.purchasedAddOnModel
      .find({
        status: PurchasedAddOnStatus.ACTIVE,
        expiresAt: { $lt: now },
      })
      .lean();

    for (const addOn of expiredByTime) {
      await this.purchasedAddOnModel.findByIdAndUpdate(addOn._id, {
        $set: { status: PurchasedAddOnStatus.EXPIRED },
      });
    }

    const activeSubscriptions = await this.subscriptionModel
      .find({ status: { $in: ['expired', 'superseded'] } })
      .select('_id userId')
      .lean();

    const expiredSubscriptionIds = activeSubscriptions.map((s) => s._id);

    const expiredByParent = await this.purchasedAddOnModel
      .find({
        status: PurchasedAddOnStatus.ACTIVE,
        subscriptionId: { $in: expiredSubscriptionIds },
      })
      .lean();

    for (const addOn of expiredByParent) {
      await this.purchasedAddOnModel.findByIdAndUpdate(addOn._id, {
        $set: { status: PurchasedAddOnStatus.EXPIRED },
      });
    }

    const allExpiredIds = [
      ...new Set([
        ...expiredByTime.map((a) => a.userId.toString()),
        ...expiredByParent.map((a) => a.userId.toString()),
      ]),
    ];

    const uniqueUserIds = [...new Set(allExpiredIds)];

    const batchSize = 100;
    for (let i = 0; i < uniqueUserIds.length; i += batchSize) {
      const batch = uniqueUserIds.slice(i, i + batchSize);
      for (const userId of batch) {
        try {
          await this.recalculateAppliedEntitlements(userId);
        } catch (err) {
          this.logger.error(`Failed to recalculate entitlements for user ${userId}:`, err);
        }
      }
    }

    this.logger.log(
      `Processed ${expiredByTime.length} time-expired and ${expiredByParent.length} parent-expired add-ons for ${uniqueUserIds.length} users`,
    );
  }

  /**
   * Wave 4 credit-pack: daily housekeeping for SMS / WhatsApp credit balances.
   *
   * Two responsibilities, run together to share one subscription scan:
   *   1. **Auto-recharge** — for paid-tier subs with autoRechargeEnabled, when
   *      balance falls below the per-channel threshold, auto-purchase the
   *      configured pack via `purchaseAddOn()`. Pricing model assumes lifetime-
   *      billed credit packs (free at the API level — payment gateway charges
   *      separately, that integration is TODO). Failures logged + skipped.
   *
   *   2. **Low-balance alert** — when balance < threshold but autoRecharge
   *      is OFF (or pack slug missing), log a warning + stamp
   *      `lastLowBalanceAlertAt`. UI / web notification dispatch is TODO —
   *      the timestamp acts as the throttle anchor (re-alert only after 7d).
   *
   * Idempotent: re-running on the same data with no balance change is a no-op
   * because top-ups push balance above threshold and the alert timestamp
   * suppresses redundant warnings.
   */
  /**
   * CRON CONTRACT - Communications credit checks (auto-recharge + low-balance)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 00:05 UTC - top up low SMS/WhatsApp balances + alert.
   * Idempotent:  YES - a top-up pushes balance above threshold so a re-run is a
   *              no-op; low-balance alert is throttled by lastLowBalanceAlertAt
   *              (7-day re-alert window).
   * Reads:       subscriptions, plans
   * Writes:      auto-purchased credit-pack add-ons; lastLowBalanceAlertAt stamp
   * Missed run:  Self-heals - the next day re-checks balances.
   * Owner:       add-ons
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_00_05_UTC, { timeZone: CRON_TIMEZONES.UTC })
  async processCommunicationsCreditChecks(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ADDONS_CREDIT_CHECKS, dayBucket(), () =>
      this.runProcessCommunicationsCreditChecks(),
    );
  }

  private async runProcessCommunicationsCreditChecks(): Promise<void> {
    this.logger.log('Processing communications credit checks (auto-recharge + low-balance)...');

    const now = new Date();
    const reAlertCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const PAID_TIERS = ['starter', 'growth', 'business', 'enterprise', 'custom'];
    const LOW_BALANCE_DEFAULT_SMS = 50;
    const LOW_BALANCE_DEFAULT_WA = 50;

    // Scan all paid-tier active/trial subscriptions with a populated plan.
    const subs = await this.subscriptionModel
      .find({ status: { $in: ['active', 'trial'] } })
      .populate<{ planId: Plan }>('planId')
      .lean();

    let topUps = 0;
    let alerts = 0;

    for (const sub of subs) {
      const plan = sub.planId as unknown as Plan;
      if (!plan?.tier || !PAID_TIERS.includes(plan.tier)) continue;

      const comms: CommsEntitlement =
        (sub.appliedEntitlements as EntitlementsWithComms | undefined)?.communications ?? {};
      const smsBalance = comms.smsCreditsBalance ?? 0;
      const waBalance = comms.whatsappCreditsBalance ?? 0;
      const smsThreshold = comms.autoRechargeThresholdSms ?? LOW_BALANCE_DEFAULT_SMS;
      const waThreshold = comms.autoRechargeThresholdWhatsapp ?? LOW_BALANCE_DEFAULT_WA;
      const lastAlert = comms.lastLowBalanceAlertAt ? new Date(comms.lastLowBalanceAlertAt) : null;

      // ── Auto-recharge ──────────────────────────────────────────────
      // Wave 7 — auto-recharge bypasses the user-facing billing flow.
      // applyCreditPackInternal() mints PurchasedAddOn + tops up balance
      // without a Razorpay charge. Keep the assumption documented on the
      // service so future payment-side work doesn't accidentally rewire
      // this path through the gateway.
      if (comms.autoRechargeEnabled) {
        if (smsBalance < smsThreshold && comms.autoRechargeSmsPackSlug) {
          try {
            const pack = await this.addOnDefinitionModel
              .findOne({ slug: comms.autoRechargeSmsPackSlug, isActive: true })
              .lean();
            if (pack && pack.type === AddOnType.CREDIT_PACK) {
              await this.applyCreditPackInternal({
                userId: String(sub.userId as Types.ObjectId),
                subscriptionId: String(sub._id),
                addOnDefinition: pack,
                quantity: 1,
                source: 'system',
              });
              topUps++;
              this.logger.log(
                `auto-recharge: subId=${String(sub._id)} userId=${String(sub.userId as Types.ObjectId)} +${pack.entitlementDelta?.creditsDelta?.sms ?? 0} sms (slug=${pack.slug})`,
              );
            }
          } catch (err: unknown) {
            const _msg = err instanceof Error ? err.message : 'unknown';
            this.logger.error(`auto-recharge SMS failed for sub=${String(sub._id)}: ${_msg}`);
          }
        }
        if (waBalance < waThreshold && comms.autoRechargeWhatsappPackSlug) {
          try {
            const pack = await this.addOnDefinitionModel
              .findOne({
                slug: comms.autoRechargeWhatsappPackSlug,
                isActive: true,
              })
              .lean();
            if (pack && pack.type === AddOnType.CREDIT_PACK) {
              await this.applyCreditPackInternal({
                userId: String(sub.userId as Types.ObjectId),
                subscriptionId: String(sub._id),
                addOnDefinition: pack,
                quantity: 1,
                source: 'system',
              });
              topUps++;
              this.logger.log(
                `auto-recharge: subId=${String(sub._id)} userId=${String(sub.userId as Types.ObjectId)} +${pack.entitlementDelta?.creditsDelta?.whatsapp ?? 0} whatsapp (slug=${pack.slug})`,
              );
            }
          } catch (err: unknown) {
            const _msg = err instanceof Error ? err.message : 'unknown';
            this.logger.error(`auto-recharge WhatsApp failed for sub=${String(sub._id)}: ${_msg}`);
          }
        }
        continue; // auto-recharge users skip the alert path
      }

      // ── Low-balance alert (no auto-recharge) ───────────────────────
      const needSmsAlert = smsBalance < smsThreshold;
      const needWaAlert = waBalance < waThreshold;
      if ((needSmsAlert || needWaAlert) && (!lastAlert || lastAlert < reAlertCutoff)) {
        this.logger.warn(
          `low-balance alert: subId=${String(sub._id)} userId=${String(sub.userId as Types.ObjectId)} sms=${smsBalance}/${smsThreshold} wa=${waBalance}/${waThreshold}`,
        );
        try {
          await this.dispatchLowBalanceAlert(String(sub.userId as Types.ObjectId), {
            sms: needSmsAlert ? { balance: smsBalance, threshold: smsThreshold } : null,
            whatsapp: needWaAlert ? { balance: waBalance, threshold: waThreshold } : null,
          });
        } catch (err: unknown) {
          const _msg = err instanceof Error ? err.message : 'unknown';
          this.logger.error(`dispatchLowBalanceAlert failed for sub=${String(sub._id)}: ${_msg}`);
        }
        // Stamp timestamp regardless of dispatch outcome — anchors 7d re-alert
        // throttle so a transient failure doesn't spam the user on next run.
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          {
            $set: {
              'appliedEntitlements.communications.lastLowBalanceAlertAt': now,
            },
          },
        );
        alerts++;
      }
    }

    this.logger.log(
      `Communications credit checks: ${topUps} auto-recharge top-ups, ${alerts} low-balance alerts.`,
    );
  }

  /**
   * Wave 5 credit-pack: dispatch low-balance alerts to subscription owner.
   *
   * Email goes to user's primary email (best effort — silently skips if
   * user has no email on record). In-app notifications go to ALL workspaces
   * the user owns — visible wherever they're working.
   *
   * Best-effort: failures logged but don't propagate (cron must continue).
   */
  private async dispatchLowBalanceAlert(
    userId: string,
    channels: {
      sms: { balance: number; threshold: number } | null;
      whatsapp: { balance: number; threshold: number } | null;
    },
  ): Promise<void> {
    const userObjectId = new Types.ObjectId(userId);
    const user = await this.userModel.findById(userObjectId, { name: 1, email: 1 }).lean();
    if (!user) return;

    const rechargeUrl = `${env.webAppUrl}/dashboard/subscription/credits`;

    // Email — one per channel. Subject differs so they don't collapse in
    // the inbox preview.
    if (user.email) {
      if (channels.sms) {
        await this.mailService
          .sendLowCreditBalanceEmail({
            to: user.email,
            userName: user.name || 'there',
            channel: 'SMS',
            balance: channels.sms.balance,
            threshold: channels.sms.threshold,
            rechargeUrl,
          })
          .catch((err) =>
            this.logger.error(
              `low-balance SMS email failed: ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
      if (channels.whatsapp) {
        await this.mailService
          .sendLowCreditBalanceEmail({
            to: user.email,
            userName: user.name || 'there',
            channel: 'WhatsApp',
            balance: channels.whatsapp.balance,
            threshold: channels.whatsapp.threshold,
            rechargeUrl,
          })
          .catch((err) =>
            this.logger.error(
              `low-balance WhatsApp email failed: ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
    }

    // In-app notifications — fan out to every workspace owned by the user.
    // Notifications are workspace-scoped, so the user sees the alert in
    // whichever workspace they're currently using.
    const workspaces = await this.workspaceModel
      .find({ ownerId: userObjectId, isActive: { $ne: false } }, { _id: 1 })
      .lean();

    for (const ws of workspaces) {
      const wsId = ws._id.toString();
      if (channels.sms) {
        await this.notificationsService
          .createNotification(wsId, {
            recipientId: userId,
            title: `Low SMS credit balance — ${channels.sms.balance} left`,
            message: `Your SMS credits dropped below ${channels.sms.threshold}. Top up an SMS pack to keep reminders flowing.`,
            type: 'warning',
            metadata: {
              entityType: 'credit_balance',
              channel: 'sms',
              balance: channels.sms.balance,
              threshold: channels.sms.threshold,
              rechargeUrl,
            },
          })
          .catch((err) =>
            this.logger.error(
              `low-balance SMS notification failed for ws=${wsId}: ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
      if (channels.whatsapp) {
        await this.notificationsService
          .createNotification(wsId, {
            recipientId: userId,
            title: `Low WhatsApp credit balance — ${channels.whatsapp.balance} left`,
            message: `Your WhatsApp credits dropped below ${channels.whatsapp.threshold}. Top up a WhatsApp pack to keep reminders flowing.`,
            type: 'warning',
            metadata: {
              entityType: 'credit_balance',
              channel: 'whatsapp',
              balance: channels.whatsapp.balance,
              threshold: channels.whatsapp.threshold,
              rechargeUrl,
            },
          })
          .catch((err) =>
            this.logger.error(
              `low-balance WhatsApp notification failed for ws=${wsId}: ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
    }
  }

  /**
   * Wave 8.1 — ops alert for "MSG91 wallet needs top-up". Mirrors the
   * customer-facing `dispatchLowBalanceAlert` shape but routes to the
   * platform ops mailbox + admin in-app + best-effort DLT-SMS to the ops
   * phone. Throttled via `OpsAlertState` (7-day default).
   *
   * NO refund implications — this is purely a paging signal. Customer
   * credits stay where they are; ops decides what to do (top up MSG91,
   * manual refund, etc).
   *
   * `runwayDays` is computed by caller from `Msg91BalanceService.getStatus`
   * to avoid a circular import on this service.
   */
  async dispatchOpsLowMsg91Alert(args: {
    context: 'pack_purchase' | 'send_skipped';
    balancePaise: number;
    requiredPaise: number;
    runwayDays: number;
    workspaceId?: string;
    note?: string;
  }): Promise<{ sent: boolean; throttled?: boolean }> {
    const opsEmail = env.ops.msg91AlertEmail;
    const opsSmsMobile = env.ops.msg91AlertSmsMobile;
    const opsSmsTemplateId = env.ops.msg91AlertDltTemplateId;
    const throttleDays = env.ops.alertThrottleDays;
    const ALERT_KEY = 'msg91_topup_needed';

    // Throttle check via OpsAlertState (lazy lookup of the model on the
    // existing connection — collection auto-creates on first write).
    try {
      const conn = this.subscriptionModel.db;
      const opsState = conn.collection('opsalertstates');
      const cutoff = new Date(Date.now() - throttleDays * 24 * 60 * 60 * 1000);
      const existing = await opsState.findOne({ key: ALERT_KEY });
      if (existing?.lastFiredAt && existing.lastFiredAt > cutoff) {
        this.logger.log(`dispatchOpsLowMsg91Alert: throttled — last fired ${existing.lastFiredAt}`);
        return { sent: false, throttled: true };
      }
      await opsState.updateOne(
        { key: ALERT_KEY },
        {
          $set: {
            key: ALERT_KEY,
            lastFiredAt: new Date(),
            lastContext: {
              context: args.context,
              balancePaise: args.balancePaise,
              requiredPaise: args.requiredPaise,
              runwayDays: args.runwayDays,
              workspaceId: args.workspaceId,
            },
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `dispatchOpsLowMsg91Alert throttle-state lookup failed (continuing): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    // Email — primary channel.
    if (opsEmail) {
      await this.mailService
        .sendOpsMsg91TopUpAlert({
          to: opsEmail,
          balancePaise: args.balancePaise,
          requiredPaise: args.requiredPaise,
          runwayDays: args.runwayDays,
          context: args.context,
          workspaceId: args.workspaceId,
          note: args.note,
        })
        .catch((err) =>
          this.logger.error(
            `ops email alert failed: ${err instanceof Error ? err.message : 'unknown'}`,
          ),
        );
    } else {
      this.logger.warn(
        'dispatchOpsLowMsg91Alert: OPS_MSG91_ALERT_EMAIL not configured — email skipped',
      );
    }

    // In-app — fan out to all admin users (best-effort, all-or-none-fail).
    try {
      const admins = await this.userModel
        .find({ isAdmin: true, isActive: { $ne: false } }, { _id: 1, name: 1 })
        .lean();
      // Pick the first workspace each admin owns (notifications are
      // workspace-scoped). If admin has no workspace, skip — they'll see
      // the email anyway.
      for (const admin of admins) {
        const adminWs = await this.workspaceModel
          .findOne({ ownerId: admin._id, isActive: { $ne: false } }, { _id: 1 })
          .lean();
        if (!adminWs) continue;
        await this.notificationsService
          .createNotification(adminWs._id.toString(), {
            recipientId: admin._id.toString(),
            title: `MSG91 wallet low — ₹${(args.balancePaise / 100).toLocaleString('en-IN')} (${args.runwayDays}d runway)`,
            message:
              args.context === 'pack_purchase'
                ? `Customer just bought a pack. Top up MSG91 to cover the implied volume.`
                : `A reminder send was skipped due to empty MSG91 wallet. Top up now.`,
            type: 'error',
            metadata: {
              entityType: 'msg91_wallet',
              context: args.context,
              balancePaise: args.balancePaise,
              requiredPaise: args.requiredPaise,
              runwayDays: args.runwayDays,
              rechargeUrl: '/admin/communications/msg91-balance',
            },
          })
          .catch((err) =>
            this.logger.error(
              `ops in-app notif failed for admin=${String(admin._id)}: ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `ops in-app fanout failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    // DLT SMS to ops phone — tertiary, best-effort. Bypass the wallet
    // pre-flight (fail-open via a marker workspace context). If MSG91
    // itself is dead, this fails silently — email + in-app remain
    // authoritative.
    if (opsSmsMobile && opsSmsTemplateId && this.smsService) {
      const opsWsId = env.ops.alertWorkspaceId;
      if (!opsWsId) {
        this.logger.debug(
          'dispatchOpsLowMsg91Alert: OPS_ALERT_WORKSPACE_ID not set — skipping ops-SMS (workspace required for SmsService scope)',
        );
      } else {
        await this.smsService
          .sendDltSms({
            workspaceId: opsWsId,
            mobile: opsSmsMobile,
            templateId: opsSmsTemplateId,
            vars: {
              VAR1: String(Math.floor(args.balancePaise / 100)),
              VAR2: String(args.runwayDays),
            },
          })
          .catch((err: any) =>
            this.logger.warn(
              `ops SMS alert failed (non-fatal): ${err instanceof Error ? err.message : 'unknown'}`,
            ),
          );
      }
    }

    return { sent: true };
  }

  async handleSubscriptionChange(
    userId: string,
    oldSubId: string | null,
    newSubId: string,
    newPlan: Plan,
  ): Promise<void> {
    if (!oldSubId) {
      return;
    }

    const oldAddOns = await this.purchasedAddOnModel
      .find({
        userId: new Types.ObjectId(userId),
        subscriptionId: new Types.ObjectId(oldSubId),
        status: PurchasedAddOnStatus.ACTIVE,
      })
      .lean();

    if (oldAddOns.length === 0) {
      return;
    }

    const newPlanEntitlements = newPlan.entitlements;

    for (const addOn of oldAddOns) {
      let newStatus = PurchasedAddOnStatus.ACTIVE;
      let shouldMigrate = true;

      if (addOn.entitlementDelta.targetModule) {
        const newModules = newPlanEntitlements.modules ?? [];
        if (newModules.includes(addOn.entitlementDelta.targetModule)) {
          newStatus = PurchasedAddOnStatus.SUPERSEDED;
          shouldMigrate = false;
        }
      }

      if (
        addOn.entitlementDelta.targetSubFeatureModule &&
        addOn.entitlementDelta.targetSubFeatureKey
      ) {
        const newModuleAccess = newPlanEntitlements.moduleAccess ?? [];
        const targetModule = addOn.entitlementDelta.targetSubFeatureModule;
        const targetKey = addOn.entitlementDelta.targetSubFeatureKey;
        const targetAccess = addOn.entitlementDelta.targetSubFeatureAccess;

        type ModuleAccessLike2 = {
          module: string;
          subFeatures?: Array<{ key: string; access: 'locked' | 'limited' | 'full' }>;
        };
        const moduleAccess = (newModuleAccess as ModuleAccessLike2[]).find(
          (m) => m.module === String(targetModule),
        );
        if (moduleAccess) {
          const sf = moduleAccess.subFeatures?.find((s) => s.key === targetKey);
          if (sf) {
            const accessOrder = { locked: 0, limited: 1, full: 2 };
            if (
              (accessOrder[sf.access] ?? 0) >=
              (accessOrder[targetAccess as keyof typeof accessOrder] ?? 0)
            ) {
              newStatus = PurchasedAddOnStatus.SUPERSEDED;
              shouldMigrate = false;
            }
          }
        }
      }

      if (shouldMigrate) {
        await this.purchasedAddOnModel.findByIdAndUpdate(addOn._id, {
          $set: {
            subscriptionId: new Types.ObjectId(newSubId),
          },
        });
      } else {
        await this.purchasedAddOnModel.findByIdAndUpdate(addOn._id, {
          $set: {
            status: newStatus,
          },
        });
      }
    }

    await this.recalculateAppliedEntitlements(userId);

    this.logger.log(
      `Handled subscription change for user ${userId}: migrated ${oldAddOns.length} add-ons`,
    );
  }
}
