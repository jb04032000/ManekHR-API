import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { Plan } from '../subscriptions/schemas/plan.schema';
import { User } from '../users/schemas/user.schema';
import {
  ConnectAllowanceService,
  ConnectAllowances,
  resolveConnectAllowances,
} from '../connect/monetization/connect-allowance.service';
import { ConnectUsageService, ConnectUsageRow } from '../connect/usage/connect-usage.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import {
  AdminConnectEntitlementsOverrideDto,
  CONNECT_OVERRIDE_KEYS,
} from './dto/admin-connect-entitlements.dto';

/** Audit action verbs for the per-user Connect entitlement override. */
const AUDIT_ACTION_SET = 'admin_set_connect_entitlement_override';
const AUDIT_ACTION_CLEAR = 'admin_clear_connect_entitlement_override';
const AUDIT_ENTITY_TYPE = 'connect_entitlements_override';

/**
 * Admin read/write view of one person's effective Connect allowances + usage,
 * plus their per-user entitlement override.
 *
 * Read = ONE call assembling four facets, each from the SAME service the runtime
 * uses (no logic forked):
 *   - planDefaults : the plan/base block the override layers over, normalized
 *                    with the canonical {@link resolveConnectAllowances}.
 *   - override     : the raw entitlementsOverride.connect (what admin set), or null.
 *   - effective    : ConnectAllowanceService.getAllowances() (authoritative merge).
 *   - usage        : ConnectUsageService.getUsageForUser() (used/limit/over-limit).
 *
 * Write = set or clear `entitlementsOverride.connect` on the person's ACTIVE/TRIAL
 * Connect subscription (the exact doc getAllowances reads). Every mutation is
 * audited (actor admin, target user, before/after diff). Effects are immediate:
 * getAllowances reads per-request with no cache, so the next enforcement check
 * already sees the new values — nothing to invalidate.
 *
 * Linked to: connect/monetization/connect-allowance.service.ts (merge it never
 * touches), connect/usage/connect-usage.service.ts, audit/audit.service.ts.
 */
@Injectable()
export class AdminConnectEntitlementsService {
  private readonly logger = new Logger(AdminConnectEntitlementsService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name)
    private readonly planModel: Model<Plan>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly allowances: ConnectAllowanceService,
    private readonly usage: ConnectUsageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Assemble the admin entitlements view for a person. Throws 400 on a malformed
   * id and 404 when the user does not exist (so the screen can show a clean "not
   * found" rather than an empty merge).
   */
  async getEntitlements(userId: string): Promise<AdminConnectEntitlementsView> {
    this.assertValidObjectId(userId);

    const user = await this.userModel
      .findById(userId)
      .select('name email mobile')
      .lean<{ _id: Types.ObjectId; name?: string; email?: string; mobile?: string }>()
      .exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    // The ONE subscription the allowance merge reads (active/trial Connect),
    // with its plan name/tier populated for display.
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        // Bundle-ready: a bundle sub carries the user's Connect entitlements too.
        product: { $in: ['connect', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      })
      .populate('planId', 'name tier')
      .lean<ConnectSubLean | null>()
      .exec();

    const baseConnect = await this.resolveBaseConnectBlock(sub);
    const overrideConnect = this.readOverrideConnect(sub);

    const [effective, usage] = await Promise.all([
      this.allowances.getAllowances(userId),
      this.usage.getUsageForUser(userId),
    ]);

    const plan = sub?.planId as { name?: string; tier?: string } | undefined;

    return {
      user: {
        id: String(user._id),
        name: user.name ?? null,
        email: user.email ?? null,
        mobile: user.mobile ?? null,
      },
      hasConnectSubscription: !!sub,
      subscriptionId: sub ? String(sub._id) : null,
      plan: sub
        ? {
            name: plan?.name ?? null,
            tier: plan?.tier ?? null,
            status: sub.status,
          }
        : null,
      planDefaults: resolveConnectAllowances(baseConnect),
      override: overrideConnect,
      effective,
      usage,
    };
  }

  /**
   * Replace the connect override block with exactly the fields the admin supplied
   * (whitelisted to CONNECT_OVERRIDE_KEYS). Provided fields override; omitted
   * fields fall back to the plan. An empty payload clears the connect override.
   * Requires an active/trial Connect subscription to attach to.
   */
  async setOverride(
    userId: string,
    dto: AdminConnectEntitlementsOverrideDto,
    actorId: string,
  ): Promise<AdminConnectEntitlementsView> {
    this.assertValidObjectId(userId);
    const sub = await this.loadWritableSub(userId);

    const nextConnect = this.pickOverride(dto);
    const before = this.cloneOverride(sub.entitlementsOverride);

    // Preserve any non-connect override keys (e.g. an ERP block) untouched.
    const nextOverride: Record<string, unknown> = { ...(sub.entitlementsOverride ?? {}) };
    if (Object.keys(nextConnect).length === 0) {
      delete nextOverride.connect;
    } else {
      nextOverride.connect = nextConnect;
    }
    const hasAny = Object.keys(nextOverride).length > 0;

    sub.entitlementsOverride = hasAny ? nextOverride : undefined;
    sub.adminEntitlementOverride = hasAny;
    await sub.save();

    await this.writeAudit(
      Object.keys(nextConnect).length === 0 ? AUDIT_ACTION_CLEAR : AUDIT_ACTION_SET,
      actorId,
      userId,
      sub._id,
      before,
      this.cloneOverride(sub.entitlementsOverride),
    );

    return this.getEntitlements(userId);
  }

  /**
   * Clear the connect override entirely (restores plan values). Non-connect
   * override keys are preserved. Requires an active/trial Connect subscription.
   */
  async clearOverride(userId: string, actorId: string): Promise<AdminConnectEntitlementsView> {
    this.assertValidObjectId(userId);
    const sub = await this.loadWritableSub(userId);

    const before = this.cloneOverride(sub.entitlementsOverride);
    const nextOverride: Record<string, unknown> = { ...(sub.entitlementsOverride ?? {}) };
    delete nextOverride.connect;
    const hasAny = Object.keys(nextOverride).length > 0;

    sub.entitlementsOverride = hasAny ? nextOverride : undefined;
    sub.adminEntitlementOverride = hasAny;
    await sub.save();

    await this.writeAudit(
      AUDIT_ACTION_CLEAR,
      actorId,
      userId,
      sub._id,
      before,
      this.cloneOverride(sub.entitlementsOverride),
    );

    return this.getEntitlements(userId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The active/trial Connect subscription doc to write the override onto. */
  private async loadWritableSub(userId: string) {
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        // Bundle-ready: a bundle sub carries the user's Connect entitlements too.
        product: { $in: ['connect', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      })
      .exec();
    if (!sub) {
      // DEVIATION: overrides attach to an existing Connect subscription. A person
      // on the implicit free fallback (no sub row) has nothing to attach to;
      // creating one is a logical change out of this pass's scope. Assign a
      // Connect plan first via the existing admin assign flow.
      throw new NotFoundException(
        'This person has no active Connect subscription to override. Assign a Connect plan first.',
      );
    }
    return sub;
  }

  /** The base `connect` block the override layers over (snapshot or free plan). */
  private async resolveBaseConnectBlock(
    sub: ConnectSubLean | null,
  ): Promise<Partial<ConnectAllowances> | undefined> {
    if (sub) {
      return (sub.appliedEntitlements as { connect?: Partial<ConnectAllowances> })?.connect;
    }
    // Mirror getAllowances' no-subscription fallback to the seeded connect_free plan.
    const freePlan = await this.planModel
      .findOne({ product: 'connect', tier: 'connect_free', isActive: true })
      .lean<{ entitlements?: { connect?: Partial<ConnectAllowances> } }>()
      .exec();
    return freePlan?.entitlements?.connect;
  }

  private readOverrideConnect(sub: ConnectSubLean | null): Partial<ConnectAllowances> | null {
    const connect = (sub?.entitlementsOverride as { connect?: Partial<ConnectAllowances> })
      ?.connect;
    return connect && Object.keys(connect).length > 0 ? connect : null;
  }

  /** Copy only the whitelisted keys that are actually present in the payload. */
  private pickOverride(dto: AdminConnectEntitlementsOverrideDto): Partial<ConnectAllowances> {
    const out: Record<string, unknown> = {};
    for (const key of CONNECT_OVERRIDE_KEYS) {
      const value = dto[key];
      if (value !== undefined && value !== null) {
        out[key] = value;
      }
    }
    return out as Partial<ConnectAllowances>;
  }

  private cloneOverride(override?: Record<string, unknown>): Record<string, unknown> | null {
    if (!override || Object.keys(override).length === 0) return null;
    return JSON.parse(JSON.stringify(override)) as Record<string, unknown>;
  }

  private assertValidObjectId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid user id.');
    }
  }

  /**
   * Audit every set/clear (person-centric → workspaceId null). before/after carry
   * the full override doc so the diff is reconstructable. Fire-and-forget on the
   * persist failure so a logging hiccup never blocks the admin write.
   */
  private async writeAudit(
    action: string,
    actorId: string,
    targetUserId: string,
    subscriptionId: Types.ObjectId,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.audit.logEvent({
        workspaceId: null,
        module: AppModule.CONNECT,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: targetUserId,
        action,
        actorId,
        before: before ?? undefined,
        after: after ?? undefined,
        meta: { subscriptionId: String(subscriptionId) },
      });
    } catch (err) {
      this.logger.warn(
        `Connect entitlement override audit failed action=${action} user=${targetUserId} err=${
          (err as Error).message
        }`,
      );
    }
  }
}

/** Lean shape of the populated Connect subscription this service reads. */
interface ConnectSubLean {
  _id: Types.ObjectId;
  status: string;
  appliedEntitlements?: Record<string, unknown>;
  entitlementsOverride?: Record<string, unknown>;
  planId?: { name?: string; tier?: string } | Types.ObjectId;
}

/** The admin three-section view + usage returned by GET. */
export interface AdminConnectEntitlementsView {
  user: { id: string; name: string | null; email: string | null; mobile: string | null };
  hasConnectSubscription: boolean;
  subscriptionId: string | null;
  plan: { name: string | null; tier: string | null; status: string } | null;
  planDefaults: ConnectAllowances;
  override: Partial<ConnectAllowances> | null;
  effective: ConnectAllowances;
  usage: ConnectUsageRow[];
}
