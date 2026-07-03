import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Plan } from '../../schemas/plan.schema';
import { AuditAction, AuditLogService } from './audit-log.service';

interface CreateCustomPlanInput {
  adminUserId: string;
  name: string;
  tier: string;
  monthlyPrice: number;
  yearlyPrice: number;
  /** EITHER assignedUserId OR assignedWorkspaceId required for a custom plan. */
  assignedUserId?: string;
  assignedWorkspaceId?: string;
  description?: string;
  entitlements?: Record<string, unknown>;
  trialDurationDays?: number;
  trialCardRequired?: boolean;
  /** Task 3 — optional/configurable subscription-plan GST. Undefined = ON. */
  gstEnabled?: boolean;
  isPriceTaxInclusive?: boolean;
  gstRatePercent?: number;
  sacCode?: string;
  supportsAutoRenew?: boolean;
  supportsOneTime?: boolean;
  recurringTotalCountMonthly?: number;
  recurringTotalCountYearly?: number;
}

interface UpdateCustomPlanInput {
  name?: string;
  monthlyPrice?: number;
  yearlyPrice?: number;
  description?: string;
  entitlements?: Record<string, unknown>;
  trialDurationDays?: number;
  trialCardRequired?: boolean;
  /** Task 3 — optional/configurable subscription-plan GST. Undefined = ON. */
  gstEnabled?: boolean;
  isPriceTaxInclusive?: boolean;
  gstRatePercent?: number;
  sacCode?: string;
  supportsAutoRenew?: boolean;
  supportsOneTime?: boolean;
  recurringTotalCountMonthly?: number;
  recurringTotalCountYearly?: number;
  isActive?: boolean;
}

/**
 * Custom-plan CRUD (D1i). Custom plans (`Plan.isCustom=true`) are
 * private to a specific User OR Workspace and don't show up in the
 * public pricing page. Used for negotiated enterprise deals,
 * partner-specific tiers, internal-employee comp accounts.
 *
 * Eligibility enforcement (already in place D1b/D1c):
 *   `SubscriptionCheckoutService.assertPlanEligibleForUser` checks
 *   `Plan.assignedUserId == requestingUserId` OR
 *   `Plan.assignedWorkspaceId` membership for owner/admin role.
 *
 * Lazy Razorpay plan mirroring (D1c) works for custom plans the same
 * way as catalogue plans — first mandate use creates the Razorpay-side
 * plan and caches the id. Custom plans are NEVER reused across users,
 * so each gets its own Razorpay plan id (no orphan concern).
 */
@Injectable()
export class AdminPlanService {
  private readonly logger = new Logger(AdminPlanService.name);

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    private readonly audit: AuditLogService,
  ) {}

  async createCustomPlan(input: CreateCustomPlanInput): Promise<Plan> {
    if (!input.assignedUserId && !input.assignedWorkspaceId) {
      throw new BadRequestException('Custom plan requires assignedUserId OR assignedWorkspaceId');
    }
    if (input.assignedUserId && input.assignedWorkspaceId) {
      throw new BadRequestException(
        'Custom plan cannot be assigned to BOTH user and workspace — pick one',
      );
    }
    if (input.monthlyPrice < 0 || input.yearlyPrice < 0) {
      throw new BadRequestException('Prices must be non-negative');
    }

    const created = await this.planModel.create({
      name: input.name,
      tier: input.tier,
      isActive: true,
      isCustom: true,
      isPubliclyVisible: false,
      assignedUserId: input.assignedUserId ? new Types.ObjectId(input.assignedUserId) : undefined,
      assignedWorkspaceId: input.assignedWorkspaceId
        ? new Types.ObjectId(input.assignedWorkspaceId)
        : undefined,
      monthlyPrice: input.monthlyPrice,
      yearlyPrice: input.yearlyPrice,
      ...(input.description ? { description: input.description } : {}),
      ...(input.entitlements ? { entitlements: input.entitlements } : {}),
      ...(input.trialDurationDays !== undefined
        ? { trialDurationDays: input.trialDurationDays }
        : {}),
      ...(input.trialCardRequired !== undefined
        ? { trialCardRequired: input.trialCardRequired }
        : {}),
      // Task 3 — persist gstEnabled only when explicitly set; otherwise the
      // schema default (true / ON) applies. updateCustomPlan copies it via its
      // defined-key loop, so no extra wiring is needed there.
      ...(input.gstEnabled !== undefined ? { gstEnabled: input.gstEnabled } : {}),
      ...(input.isPriceTaxInclusive !== undefined
        ? { isPriceTaxInclusive: input.isPriceTaxInclusive }
        : {}),
      ...(input.gstRatePercent !== undefined ? { gstRatePercent: input.gstRatePercent } : {}),
      ...(input.sacCode ? { sacCode: input.sacCode } : {}),
      ...(input.supportsAutoRenew !== undefined
        ? { supportsAutoRenew: input.supportsAutoRenew }
        : {}),
      ...(input.supportsOneTime !== undefined ? { supportsOneTime: input.supportsOneTime } : {}),
      ...(input.recurringTotalCountMonthly !== undefined
        ? { recurringTotalCountMonthly: input.recurringTotalCountMonthly }
        : {}),
      ...(input.recurringTotalCountYearly !== undefined
        ? { recurringTotalCountYearly: input.recurringTotalCountYearly }
        : {}),
    });

    this.logger.log(
      // String() around the ObjectId — lint restrict-template-expressions.
      `Admin custom plan created admin=${input.adminUserId} plan=${String(created._id)} name="${input.name}" assignedUser=${input.assignedUserId} assignedWorkspace=${input.assignedWorkspaceId}`,
    );
    await this.audit.log({
      action: AuditAction.AdminCustomPlanCreated,
      actorType: 'admin',
      actorUserId: input.adminUserId,
      targetUserId: input.assignedUserId,
      planId: String(created._id),
      metadata: {
        name: input.name,
        tier: input.tier,
        monthlyPrice: input.monthlyPrice,
        yearlyPrice: input.yearlyPrice,
        assignedWorkspaceId: input.assignedWorkspaceId,
      },
    });
    return created;
  }

  async updateCustomPlan(
    planId: string,
    input: UpdateCustomPlanInput,
    adminUserId?: string,
  ): Promise<Plan> {
    const existing = await this.planModel.findById(planId).exec();
    if (!existing) throw new NotFoundException('Plan not found');
    if (!existing.isCustom) {
      throw new BadRequestException(
        'This endpoint can only modify custom plans (Plan.isCustom=true)',
      );
    }
    const update: any = {};
    for (const k of Object.keys(input) as (keyof UpdateCustomPlanInput)[]) {
      if (input[k] !== undefined) update[k] = input[k];
    }
    const updated = await this.planModel
      .findOneAndUpdate({ _id: planId }, { $set: update }, { new: true })
      .exec();
    await this.audit.log({
      action: AuditAction.AdminCustomPlanUpdated,
      actorType: 'admin',
      actorUserId: adminUserId,
      targetUserId: existing.assignedUserId ? String(existing.assignedUserId) : undefined,
      planId,
      metadata: { changedKeys: Object.keys(update) },
    });
    return updated as Plan;
  }

  async listCustomPlans(args: {
    assignedUserId?: string;
    assignedWorkspaceId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const filter: any = { isCustom: true };
    if (args.assignedUserId) {
      filter.assignedUserId = new Types.ObjectId(args.assignedUserId);
    }
    if (args.assignedWorkspaceId) {
      filter.assignedWorkspaceId = new Types.ObjectId(args.assignedWorkspaceId);
    }
    if (args.isActive !== undefined) filter.isActive = args.isActive;

    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const [items, total] = await Promise.all([
      this.planModel.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).exec(),
      this.planModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }

  async fetchCustomPlan(planId: string): Promise<Plan> {
    const plan = await this.planModel.findById(planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isCustom) {
      throw new BadRequestException('This endpoint only serves custom plans');
    }
    return plan;
  }

  async archiveCustomPlan(planId: string, adminUserId?: string): Promise<Plan> {
    const plan = await this.planModel.findById(planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isCustom) {
      throw new BadRequestException('Only custom plans can be archived here');
    }
    plan.isActive = false;
    await plan.save();
    await this.audit.log({
      action: AuditAction.AdminCustomPlanArchived,
      actorType: 'admin',
      actorUserId: adminUserId,
      targetUserId: plan.assignedUserId ? String(plan.assignedUserId) : undefined,
      planId,
    });
    return plan;
  }
}
