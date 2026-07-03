import { Injectable, Inject, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import {
  CustomPlanRequest,
  type CustomPlanRequestDocument,
  type CustomPlanRequestKind,
  type CustomPlanRequestStatus,
} from './schemas/custom-plan-request.schema';
import { User } from '../users/schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import {
  AdminUpdateCustomPlanRequestDto,
  CreateCustomPlanRequestDto,
  CreatePlanInterestRequestDto,
} from './dto/custom-plan-request.dto';

/**
 * CustomPlanRequestsService -- create + admin-triage a custom-plan sales lead.
 *
 * Cross-module links: AuditService (write seam, AppModule.SUBSCRIPTION),
 * PostHogService (@Optional analytics), User (denormalize requester identity for
 * the admin list). No subscription side effects -- this is pure lead capture; the
 * admin contacts the user and provisions a tailored plan manually.
 */
@Injectable()
export class CustomPlanRequestsService {
  private readonly logger = new Logger(CustomPlanRequestsService.name);

  constructor(
    @InjectModel(CustomPlanRequest.name)
    private readonly model: Model<CustomPlanRequestDocument>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * Create a custom-plan lead from the authenticated user. Denormalizes the
   * requester's name/email for the admin list so it never needs a join.
   */
  async create(
    userId: string,
    dto: CreateCustomPlanRequestDto,
  ): Promise<CustomPlanRequestDocument> {
    const userObjectId = new Types.ObjectId(userId);
    const user = await this.userModel
      .findById(userObjectId)
      .select('name email')
      .lean<{ name?: string; email?: string }>()
      .exec();

    try {
      const doc = (await this.model.create({
        userId: userObjectId,
        userName: user?.name?.trim() ?? '',
        userEmail: user?.email?.trim() ?? '',
        product: dto.product ?? 'erp',
        kind: 'custom',
        teamMembers: dto.teamMembers,
        companiesOrFactories: dto.companiesOrFactories ?? 0,
        mobile: dto.mobile.trim(),
        note: dto.note?.trim() ?? '',
        status: 'new',
      })) as CustomPlanRequestDocument;

      await this.audit.logEvent({
        module: AppModule.SUBSCRIPTION,
        entityType: 'CustomPlanRequest',
        entityId: String(doc._id),
        action: 'custom_plan_request_created',
        actorId: userId,
        meta: {
          teamMembers: dto.teamMembers,
          companiesOrFactories: dto.companiesOrFactories ?? 0,
        },
      });
      this.posthog?.capture({
        distinctId: userId,
        event: 'subscription.custom_plan_requested',
        properties: {
          customPlanRequestId: String(doc._id),
          teamMembers: dto.teamMembers,
          companiesOrFactories: dto.companiesOrFactories ?? 0,
        },
      });
      this.logger.log(`Custom plan request created id=${String(doc._id)} userId=${userId}`);
      return doc;
    } catch (err) {
      Sentry.captureException(err, {
        tags: { module: 'subscription.custom_plan_request', op: 'create' },
      });
      throw err;
    }
  }

  /**
   * Create a PLAN-INTEREST lead: a Subscribe click on a predefined paid plan while
   * online payments are off. Same collection as the custom lead (kind='plan'), so
   * the admin triages both in one list. Denormalizes the requester identity and
   * the plan tier/name so the admin row needs no join. NO subscription is created
   * -- the team contacts the user and provisions the plan manually (or the user
   * self-serves once payments go live and this path is bypassed).
   */
  async createPlanInterest(
    userId: string,
    dto: CreatePlanInterestRequestDto,
  ): Promise<CustomPlanRequestDocument> {
    const userObjectId = new Types.ObjectId(userId);
    const user = await this.userModel
      .findById(userObjectId)
      .select('name email')
      .lean<{ name?: string; email?: string }>()
      .exec();

    try {
      const doc = (await this.model.create({
        userId: userObjectId,
        userName: user?.name?.trim() ?? '',
        userEmail: user?.email?.trim() ?? '',
        product: dto.product ?? 'erp',
        kind: 'plan',
        planId: new Types.ObjectId(dto.planId),
        planTier: dto.planTier?.trim() ?? '',
        planName: dto.planName?.trim() ?? '',
        teamMembers: dto.teamMembers,
        companiesOrFactories: dto.companiesOrFactories ?? 0,
        mobile: dto.mobile.trim(),
        note: dto.note?.trim() ?? '',
        status: 'new',
      })) as CustomPlanRequestDocument;

      await this.audit.logEvent({
        module: AppModule.SUBSCRIPTION,
        entityType: 'CustomPlanRequest',
        entityId: String(doc._id),
        action: 'plan_interest_request_created',
        actorId: userId,
        meta: { planId: dto.planId, planTier: dto.planTier, planName: dto.planName },
      });
      this.posthog?.capture({
        distinctId: userId,
        event: 'subscription.plan_interest_requested',
        properties: {
          customPlanRequestId: String(doc._id),
          planId: dto.planId,
          planTier: dto.planTier,
        },
      });
      this.logger.log(
        `Plan interest request created id=${String(doc._id)} userId=${userId} plan=${dto.planTier ?? dto.planId}`,
      );
      return doc;
    } catch (err) {
      Sentry.captureException(err, {
        tags: { module: 'subscription.custom_plan_request', op: 'createPlanInterest' },
      });
      throw err;
    }
  }

  /** Admin: paginated triage list, newest first, with optional status + kind filters. */
  async adminList(opts: {
    status?: CustomPlanRequestStatus;
    kind?: CustomPlanRequestKind;
    limit?: number;
    offset?: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.kind) filter.kind = opts.kind;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean().exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }

  /** Admin: update triage status / internal note. Stamps who actioned + audits. */
  async adminUpdate(id: string, adminUserId: string, dto: AdminUpdateCustomPlanRequestDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Custom plan request not found');
    }
    const update: Record<string, unknown> = {
      handledByUserId: new Types.ObjectId(adminUserId),
    };
    if (dto.status !== undefined) update.status = dto.status;
    if (dto.adminNote !== undefined) update.adminNote = dto.adminNote.trim();

    const doc = await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Custom plan request not found');
    }

    await this.audit.logEvent({
      module: AppModule.SUBSCRIPTION,
      entityType: 'CustomPlanRequest',
      entityId: id,
      action: 'custom_plan_request_updated',
      actorId: adminUserId,
      meta: { status: dto.status },
    });
    return doc;
  }
}
