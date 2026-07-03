import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppModule } from '../../common/enums/modules.enum';
import { AuditEvent } from './schemas/audit-event.schema';
import { User } from '../users/schemas/user.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

/**
 * Tier-aware audit-log retention (per MODULE_INVENTORY.md §3.5.4).
 * Tier keys here are seeded defaults — admin can rename via /admin/tiers.
 * If admin renames, lookup falls back to FALLBACK_RETENTION_DAYS.
 *
 * TODO: Once Tier schema gains `retention.auditLogDays` field, read directly
 * from the loaded Tier doc and remove this lookup. Tracked in drift #31.
 */
const SEEDED_RETENTION_DAYS_BY_TIER: Record<string, number | null> = {
  free: 30,
  starter: 90,
  pro: 365, // legacy alias for growth
  growth: 365,
  business: 730,
  enterprise: null, // null = unlimited (no TTL)
  custom: null,
};
const FALLBACK_RETENTION_DAYS = 365; // safe default for unknown tier keys

export interface CreateAuditEventInput {
  /**
   * Workspace tenant. Required for tenant-scoped events. Omit / pass null /
   * undefined for identity-layer events (auth lifecycle) which have no
   * workspace context — they will be persisted with `workspaceId: null` and
   * the default 365-day retention.
   */
  workspaceId?: string | Types.ObjectId | null;
  module: AppModule;
  entityType: string;
  entityId: string | Types.ObjectId;
  action: string;
  actorId: string | Types.ObjectId;
  actorNameSnapshot?: string;
  salaryId?: string | Types.ObjectId;
  teamMemberId?: string | Types.ObjectId;
  month?: number;
  year?: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  reason?: string;
}

/**
 * Filters for a workspace-scoped activity feed. All optional; `workspaceId` is
 * always AND-ed in by the method. When `module` is supplied the query rides the
 * `{ workspaceId, module, createdAt }` index; the `{ workspaceId, entityType,
 * entityId, createdAt }` index covers the per-entity (single-member) case.
 */
export interface WorkspaceEventsQuery {
  module?: AppModule;
  action?: string;
  actorId?: string | Types.ObjectId;
  entityType?: string;
  entityId?: string | Types.ObjectId;
  teamMemberId?: string | Types.ObjectId;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditEvent.name)
    private auditEventModel: Model<AuditEvent>,
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<Workspace>,
    @Inject(forwardRef(() => SubscriptionsService))
    private subscriptionsService: SubscriptionsService,
  ) {}

  async logEvent(input: CreateAuditEventInput) {
    const actorObjectId = toObjectId(input.actorId);
    const actorNameSnapshot =
      input.actorNameSnapshot || (await this.resolveActorName(actorObjectId));

    const workspaceObjectId = input.workspaceId != null ? toObjectId(input.workspaceId) : null;

    const expiresAt = await this.computeExpiresAt(workspaceObjectId);

    const event = new this.auditEventModel({
      workspaceId: workspaceObjectId,
      module: input.module,
      entityType: input.entityType,
      entityId: toObjectId(input.entityId),
      action: input.action,
      actorId: actorObjectId,
      actorNameSnapshot,
      salaryId: input.salaryId ? toObjectId(input.salaryId) : undefined,
      teamMemberId: input.teamMemberId ? toObjectId(input.teamMemberId) : undefined,
      month: input.month,
      year: input.year,
      before: input.before,
      after: input.after,
      meta: input.meta,
      reason: input.reason,
      expiresAt,
    });

    return event.save();
  }

  /**
   * Compute audit-event TTL based on workspace owner's subscription tier.
   * Returns null = no expiry (Enterprise/Custom). Returns a Date for tiered TTL.
   *
   * For identity-layer events (workspaceId === null) the FALLBACK retention
   * applies — auth events should expire on a sensible default rather than
   * persist forever or be dropped silently.
   *
   * Failure-tolerant: any error → returns null (event persists indefinitely;
   * better than dropping the audit event entirely).
   */
  private async computeExpiresAt(workspaceId: Types.ObjectId | null): Promise<Date | null> {
    if (workspaceId === null) {
      // Identity-layer event — apply default retention (auth events should
      // expire predictably rather than ride a workspace's unlimited retention).
      return new Date(Date.now() + FALLBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    }
    try {
      const workspace = await this.workspaceModel
        .findById(workspaceId)
        .select('ownerId')
        .lean<{ ownerId?: Types.ObjectId }>()
        .exec();
      if (!workspace?.ownerId) return null;

      const subscription = await this.subscriptionsService.getUserSubscription(
        workspace.ownerId.toString(),
      );
      const subWithTier = subscription as
        | { tier?: string; planId?: { tier?: string } }
        | null
        | undefined;
      const tierKey: string = subWithTier?.planId?.tier ?? subWithTier?.tier ?? 'free';

      const days =
        tierKey in SEEDED_RETENTION_DAYS_BY_TIER
          ? SEEDED_RETENTION_DAYS_BY_TIER[tierKey]
          : FALLBACK_RETENTION_DAYS;

      if (days === null) return null; // unlimited

      return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `computeExpiresAt failed for workspace ${workspaceId.toString()} — defaulting to no expiry. Error: ${detail}`,
      );
      return null;
    }
  }

  async listEntityEvents(workspaceId: string, entityType: string, entityId: string) {
    return this.auditEventModel
      .find({
        workspaceId: toObjectId(workspaceId),
        entityType,
        entityId: toObjectId(entityId),
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  /**
   * Workspace-scoped, filtered + paginated event list — the generic backbone
   * for per-module activity feeds. Returns RAW events; redaction of any
   * sensitive `before`/`after`/`meta` is the caller's responsibility (the
   * module owning the data applies its own policy). Always tenant-scoped by
   * `workspaceId`, so cross-tenant leak is impossible. `limit` is clamped to
   * [1, 100]; newest first.
   */
  async listWorkspaceEvents(
    workspaceId: string,
    query: WorkspaceEventsQuery = {},
  ): Promise<{ items: (AuditEvent & { createdAt?: Date })[]; total: number }> {
    const filter: Record<string, unknown> = { workspaceId: toObjectId(workspaceId) };
    if (query.module) filter.module = query.module;
    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = toObjectId(query.actorId);
    if (query.entityType) filter.entityType = query.entityType;
    if (query.entityId) filter.entityId = toObjectId(query.entityId);
    if (query.teamMemberId) filter.teamMemberId = toObjectId(query.teamMemberId);
    if (query.dateFrom || query.dateTo) {
      const createdAt: Record<string, Date> = {};
      if (query.dateFrom) createdAt.$gte = query.dateFrom;
      if (query.dateTo) createdAt.$lte = query.dateTo;
      filter.createdAt = createdAt;
    }

    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);

    const [items, total] = await Promise.all([
      this.auditEventModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean<(AuditEvent & { createdAt?: Date })[]>()
        .exec(),
      this.auditEventModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  private async resolveActorName(actorId: Types.ObjectId): Promise<string> {
    const actor = await this.userModel.findById(actorId).select('name').lean().exec();
    return actor?.name?.trim() || 'Unknown User';
  }
}
