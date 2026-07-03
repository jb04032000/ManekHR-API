/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string, @typescript-eslint/no-require-imports -- Pre-existing Mongoose populate-union + lazy-require (circular-import break) patterns; documented Phase 5 W5 carry-forward for separate refactor approval. */
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { Workspace } from './schemas/workspace.schema';
import { WorkspaceMember } from './schemas/workspace-member.schema';
import {
  AddDesignationDto,
  BrandingDto,
  ChangeMemberRoleDto,
  CreateWorkspaceDto,
  DefaulterAlertsConfigDto,
  EmployeeCodeSettingsDto,
  ExportPreferencesDto,
  InviteMemberDto,
  RenameDesignationDto,
  UpdateWorkspaceDto,
} from './dto/workspace.dto';
import { UsersService } from '../users/users.service';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { InviteNotificationDispatcher } from './invite-notification.dispatcher';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkspaceCounterService } from './workspace-counter.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import { WorkspaceRevocationService } from '../../common/workspace-revocation/workspace-revocation.service';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';
// Type-only — runtime resolution happens via ModuleRef + lazy require to
// avoid a require-time circular import (FirmsModule → LedgerModule → WorkspacesModule).
import type { FirmsService } from '../finance/firms/firms.service';
import type { AddOnsService } from '../add-ons/add-ons.service';
import type { RoleSeederService } from '../rbac/role-seeder.service';
import type { LeaveTypeSeederService } from '../leave/leave-type-seeder.service';
// Type-only — resolved lazily via ModuleRef at call time (TeamModule imports
// the @Global WorkspacesModule, so a require-time import here would be a cycle).
// Used by removeMember to fire the SAME full offboarding cascade as the Team
// directory remove (OQ-W1) when the membership is linked to a directory employee.
import type { TeamService } from '../team/team.service';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { UpdateKioskSettingsDto } from './dto/kiosk.dto';
import { UpdateNotificationPolicyDto } from './dto/notification-policy.dto';
import {
  DesignationRecord,
  getDesignationPresetForBusinessType,
  normalizeDesignationsForRead,
} from './constants/designations';
import { deriveWorkspaceCodeBase } from './workspace-code.util';
import { WORKSPACE_DELETED, type WorkspaceDeletedEvent } from './events/workspace.events';

// Auto-generation is ON by default: a workspace that never configured
// employee-code settings still issues sequential codes (owner request
// 2026-06-13). An owner who explicitly saves settings with enabled:false opts
// out. The default format embeds {WS} (the workspace code) so every code names
// its workspace; allowCustom is retired — codes are never user-supplied. Keep
// in sync with team.service DEFAULT_AUTO_CODE_SETTINGS.
const DEFAULT_EMPLOYEE_CODE_SETTINGS = {
  enabled: true,
  format: '{WS}-{PREFIX}-{####}',
  prefix: 'EMP',
  startingNumber: 1,
  allowCustom: false,
};

// Workspaces hardening OQ-W3 (approved Option A) — self-serve undo window for a
// soft-deleted workspace. For this many days after delete, the owner can restore
// it (clears the soft-delete flags). After the window the workspace disappears
// from the recovery UI, but the row + all statutory data stay retained for
// compliance (recovery then becomes an admin-only action). Standard SaaS posture
// (Slack / GitHub / Google Workspace 30-day trash).
const WORKSPACE_RESTORE_WINDOW_DAYS = 30;

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);
  private readonly tracer = trace.getTracer('workspaces');
  private readonly webAppUrl: string;
  private readonly mobileDeepLink: string;

  constructor(
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private memberModel: Model<WorkspaceMember>,
    private usersService: UsersService,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    private inviteDispatcher: InviteNotificationDispatcher,
    private configService: ConfigService,
    private workspaceCounterService: WorkspaceCounterService,
    private moduleRef: ModuleRef,
    private auditService: AuditService,
    private postHog: PostHogService,
    private revocationService: WorkspaceRevocationService,
    private notificationsService: NotificationsService,
    /**
     * Domain-event bus (the @Global EventEmitterModule, `forRoot`'d in
     * AppModule). Emits `workspace.deleted` on every soft-delete so the Connect
     * entities module can clear the dangling ERP link on linked CompanyPages /
     * Storefronts (ADR-0004 / 2026-06-18). Fire-and-forget; a slow / failing
     * listener never blocks the delete write.
     */
    private eventEmitter: EventEmitter2,
  ) {
    this.webAppUrl = this.configService.get<string>('app.webAppUrl') || 'https://app.manekhr.in';
    this.mobileDeepLink =
      this.configService.get<string>('app.mobileDeepLink') || 'zari360://invite';
  }

  /**
   * Phase 5 W5 — fire-and-forget audit-event helper. Mirrors auth's
   * `auditAuthEvent` (W4 pilot 2026-05-09). Failure here must NEVER break the
   * caller's primary operation; we swallow + Sentry-tag for follow-up.
   *
   * Accepts ObjectId | string for id fields so callers can pass raw Mongoose
   * fields without triggering `@typescript-eslint/no-base-to-string`. The
   * helper normalises via `String()` internally (safe for both ObjectId and
   * string).
   */
  auditWorkspaceEvent(input: {
    action: string;
    workspaceId: string | Types.ObjectId | null;
    actorId: string | Types.ObjectId;
    entityType?: string;
    entityId?: string | Types.ObjectId;
    actorNameSnapshot?: string;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = input.workspaceId == null ? null : String(input.workspaceId);
    const actor = String(input.actorId);
    const entity = input.entityId != null ? String(input.entityId) : (wsId ?? actor);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModule.WORKSPACES,
        entityType: input.entityType ?? 'workspace',
        entityId: entity,
        action: input.action,
        actorId: actor,
        actorNameSnapshot: input.actorNameSnapshot,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for workspace event ${input.action} (workspace ${wsId ?? '-'}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: `audit.${input.action}` },
          extra: { workspaceId: wsId, actorId: actor },
        });
      });
  }

  /**
   * Emit `workspace.deleted` (ADR-0004 / 2026-06-18). Fired once per workspace
   * after its soft-delete write, from BOTH `remove()` and
   * `softDeleteAllOwnedForErasure()`. Wrapped + swallowed: EventEmitter2 emit is
   * synchronous, so a misbehaving listener throw must never propagate back into
   * the workspace delete flow (the Connect listener also self-guards). Connect
   * listens to clear dangling ERP links on linked CompanyPages / Storefronts.
   */
  private emitWorkspaceDeleted(workspaceId: string | Types.ObjectId, ownerId: string): void {
    try {
      const payload: WorkspaceDeletedEvent = {
        workspaceId: String(workspaceId),
        ownerId,
      };
      this.eventEmitter.emit(WORKSPACE_DELETED, payload);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Failed to emit ${WORKSPACE_DELETED} for workspace ${String(workspaceId)}: ${detail}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'workspaces', op: 'emit.workspace_deleted' },
      });
    }
  }

  /**
   * Phase 5 W6 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `AuthService.withAuthSpan` (Phase 3.5 W4 pilot). Empty
   * `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op (the SDK
   * registers no exporter), but the helper still tags errors via
   * `recordException` + sets ERROR status — mirrors Sentry posture so
   * collector-disabled environments still surface failures via Sentry.
   */
  private async withWorkspaceSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Workspaces hardening OQ-W8 — strip the SMTP credential from a workspace
   * document before it leaves the service in any API response. The schema marks
   * `emailConfig.smtpConfig.pass` `select: false`, so a normal read never carries
   * it; this is belt-and-suspenders for any read that explicitly re-selected it
   * (or a future projection change), so the encrypted password can never be
   * echoed back to a client. Mutates a hydrated Mongoose doc in place (the field
   * is purely cosmetic on the response — persistence is untouched) and is a no-op
   * when the field is absent.
   */
  private stripSmtpSecret<T>(workspace: T): T {
    const ws = workspace as unknown as {
      emailConfig?: { smtpConfig?: { pass?: unknown } };
    } | null;
    if (ws?.emailConfig?.smtpConfig && 'pass' in ws.emailConfig.smtpConfig) {
      ws.emailConfig.smtpConfig.pass = undefined;
    }
    return workspace;
  }

  private async getWorkspaceLimit(userId: string): Promise<number> {
    const now = new Date();
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial', 'cancelled'] },
        $or: [{ currentPeriodEnd: { $gt: now } }, { currentPeriodEnd: { $exists: false } }],
      })
      .sort({ createdAt: -1 })
      .exec();

    this.logger.debug(
      `getWorkspaceLimit user=${userId} hasSub=${!!subscription} status=${subscription?.status ?? '-'} maxWorkspaces=${subscription?.appliedEntitlements?.maxWorkspaces ?? '-'}`,
    );

    if (!subscription) {
      return 1;
    }

    return subscription.appliedEntitlements?.maxWorkspaces ?? 1;
  }

  private async getCurrentWorkspaceCount(userId: string): Promise<number> {
    const owned = await this.workspaceModel.countDocuments({
      ownerId: new Types.ObjectId(userId),
      isDeleted: { $ne: true },
    });
    return owned;
  }

  /**
   * Recompute + persist `User.hasWorkspace` from the user's REAL ownership: true
   * iff they own at least one live (non-deleted) workspace. The flag drives the
   * post-login ERP-vs-Connect routing AND the Quick-PIN (App Lock) gate, so it
   * MUST drop back to false when an owner deletes their last workspace -- otherwise
   * a now workspace-less account keeps reading as an ERP user, gets routed into the
   * ERP shell, and is wrongly force-PIN'd (Connect has no PIN). It was previously
   * only ever SET true on create and never cleared (the "set on create, never
   * enforced" gap), which left stale-true / never-set flags behind. Call this at
   * every owner-side live-workspace count change (remove / restore). Keep the
   * "owns a live workspace" definition in sync with `getCurrentWorkspaceCount`,
   * the create() path (sets true), and migration 0046 (one-time backfill). The web
   * setup-pin guard cross-checks the real workspace list as defence-in-depth.
   */
  private async recomputeHasWorkspace(userId: string): Promise<void> {
    const ownsLiveWorkspace = await this.workspaceModel.exists({
      ownerId: new Types.ObjectId(userId),
      isDeleted: { $ne: true },
    });
    await this.usersService.update(userId, { hasWorkspace: !!ownsLiveWorkspace });
  }

  async create(userId: string, createDto: CreateWorkspaceDto): Promise<Workspace> {
    return this.withWorkspaceSpan('workspace.create', { userId }, async (span) => {
      this.logger.log(`create started for user=${userId}`);
      const maxWorkspaces = await this.getWorkspaceLimit(userId);
      const currentCount = await this.getCurrentWorkspaceCount(userId);

      this.logger.debug(
        `create validation user=${userId} max=${maxWorkspaces} current=${currentCount} willBlock=${maxWorkspaces !== -1 && currentCount >= maxWorkspaces}`,
      );

      if (maxWorkspaces !== -1 && currentCount >= maxWorkspaces) {
        throw new ForbiddenException({
          success: false,
          message: `Workspace limit reached. Your current plan allows up to ${maxWorkspaces} workspace(s).`,
          code: 'WORKSPACE_LIMIT_REACHED',
          limit: maxWorkspaces,
          current: currentCount,
          upgradeUrl: '/subscription/upgrade',
          requestMoreSeats: true,
        });
      }

      // Industry-aware designation seed (F1, 2026-05-13). Textile/garment/
      // embroidery businessTypes get the 29-role textile preset with per-locale
      // labels (Karigar terminology in gu-en/hi-en/gu); everything else gets the
      // 4-role generic preset. Caller-supplied designations override the seed.
      // Caller-supplied legacy `string[]` is coerced to records via
      // `normalizeDesignationsForRead` (preserves backward-compat for the
      // mobile-app workspace-create path).
      const designationsSeed: DesignationRecord[] =
        createDto.designations !== undefined
          ? normalizeDesignationsForRead(createDto.designations)
          : getDesignationPresetForBusinessType(createDto.businessType);

      // Immutable workspace code — the {WS} token in every employee code.
      // Generated up-front so the employee-code settings preview can render it
      // immediately. Legacy workspaces (no code) backfill lazily in team.service.
      const workspaceCode = await this.generateUniqueWorkspaceCode(createDto.name);

      const workspace = new this.workspaceModel({
        ...createDto,
        ownerId: new Types.ObjectId(userId),
        designations: designationsSeed,
        workspaceCode,
      });
      await workspace.save();
      this.logger.log(`workspace saved id=${workspace._id.toString()}`);

      const member = new this.memberModel({
        workspaceId: workspace._id,
        userId: new Types.ObjectId(userId),
        status: 'active',
        joinedAt: new Date(),
      });
      await member.save();
      this.logger.log(`owner-member saved workspace=${workspace._id.toString()}`);

      await this.usersService.update(userId, { hasWorkspace: true });
      this.logger.log(`user.hasWorkspace=true user=${userId}`);

      // Wave 4.11 — seed canonical Member role so the Grant Access modal has
      // an assignable default on first use. Idempotent + best-effort: failure
      // never rolls back workspace create (W4.10 empty-state CTA still
      // surfaces /dashboard/roles for owners to recover). Lazy require +
      // moduleRef.get avoids a require-time circular import (RbacModule
      // already imports WorkspacesModule).
      try {
        const {
          RoleSeederService: RoleSeederServiceClass,
        } = require('../rbac/role-seeder.service');
        const roleSeeder = this.moduleRef.get<RoleSeederService>(RoleSeederServiceClass, {
          strict: false,
        });
        const seedResult = await roleSeeder.seedDefaultRolesForWorkspace(workspace._id.toString());
        if (seedResult.created.length > 0) {
          this.logger.log(
            `default roles seeded workspace=${workspace._id.toString()} created=${seedResult.created.join(',')}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `default roles seed failed workspace=${workspace._id.toString()}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: 'create.seedDefaultRoles' },
          extra: { workspaceId: workspace._id.toString(), userId },
        });
      }

      // Leave epic L1 (2026-05-16) — seed the India SMB leave-type preset
      // (CL/SL/EL/Maternity/Paternity/Bereavement/Comp-Off/LWP) so the leave
      // module has a usable catalogue on first open. Idempotent + best-effort:
      // failure never rolls back workspace create. Lazy require + moduleRef.get
      // avoids a require-time circular import (mirrors the role-seeder block).
      try {
        const {
          LeaveTypeSeederService: LeaveTypeSeederServiceClass,
        } = require('../leave/leave-type-seeder.service');
        const leaveTypeSeeder = this.moduleRef.get<LeaveTypeSeederService>(
          LeaveTypeSeederServiceClass,
          { strict: false },
        );
        const seedResult = await leaveTypeSeeder.seedDefaultLeaveTypesForWorkspace(
          workspace._id.toString(),
        );
        if (seedResult.created.length > 0) {
          this.logger.log(
            `default leave types seeded workspace=${workspace._id.toString()} created=${seedResult.created.join(',')}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `default leave types seed failed workspace=${workspace._id.toString()}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: 'create.seedLeaveTypes' },
          extra: { workspaceId: workspace._id.toString(), userId },
        });
      }

      // Auto-create the 1:1 Firm record. Workspace = Firm by design — finance
      // module reads/writes a single firm derived from the workspace. Skipped
      // user-supplied fields default safely; user can complete via wizard.
      // Lazy require + ModuleRef.get avoids a require-time circular import
      // (FirmsModule transitively pulls in WorkspacesModule via LedgerModule).
      try {
        const { FirmsService: FirmsServiceClass } = require('../finance/firms/firms.service');
        const firmsService = this.moduleRef.get<FirmsService>(FirmsServiceClass, {
          strict: false,
        });
        await firmsService.create(workspace._id.toString(), userId, {
          firmName: createDto.firmName ?? createDto.name,
          businessType: createDto.businessType ?? 'trading',
          gstin: createDto.gstin,
          pan: createDto.pan,
          fyStartMonth: createDto.fyStartMonth ?? 4,
        });
        this.logger.log(`firm auto-created workspace=${workspace._id.toString()}`);
      } catch (err) {
        // Do NOT roll back the workspace — finance module gates on firm
        // completeness via setupChecklistState. Workspace stays usable.
        this.logger.error(
          `firm auto-create failed workspace=${workspace._id.toString()}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: 'create.firmAutoCreate' },
          extra: { workspaceId: workspace._id.toString(), userId },
        });
      }

      // Wave 8 — one-shot Free-tier trial credits (10 SMS, 5 WhatsApp). Idempotent
      // at AddOnsService level (`lifetimeTrialGranted` flag flips atomically),
      // so repeated workspace-create calls by the same owner do NOT re-grant.
      // Best-effort: failure must NEVER break workspace create.
      //
      // Last-workspace-delete safety (verified, no change needed): the
      // `lifetimeTrialGranted` gate lives on the owner's Subscription document
      // (keyed by userId), NOT on the workspace. Each user has exactly one
      // Subscription and it survives workspace deletion, so the delete-only-
      // workspace + create-new path this change enables CANNOT farm a second
      // trial grant — the flag is already true on the subscription. The grant is
      // therefore per-user/subscription (safe), so no anti-farming guard is
      // required here. See AddOnsService.grantTrialCreditsForWorkspace.
      try {
        const { AddOnsService: AddOnsServiceClass } = require('../add-ons/add-ons.service');
        const addOnsService = this.moduleRef.get<AddOnsService>(AddOnsServiceClass, {
          strict: false,
        });
        const result = await addOnsService.grantTrialCreditsForWorkspace(workspace._id.toString());
        if (result.granted) {
          this.logger.log(`trial credits granted workspace=${workspace._id.toString()}`);
        }
      } catch (err) {
        this.logger.error(
          `trial credit grant failed workspace=${workspace._id.toString()}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: 'create.trialCredits' },
          extra: { workspaceId: workspace._id.toString(), userId },
        });
      }

      this.auditWorkspaceEvent({
        action: 'workspace.workspace_created',
        workspaceId: workspace._id,
        actorId: userId,
        entityId: workspace._id,
        meta: { name: workspace.name, hasFirmFields: !!createDto.firmName },
      });

      const workspaceIdStr = workspace._id.toString();
      span.setAttribute('workspaceId', workspaceIdStr);

      // Resolve tier for the identify+capture properties. Best-effort — fall
      // back to 'free' so funnel events always carry a tier dimension.
      const subForTier = await this.subscriptionModel
        .findOne({
          userId: new Types.ObjectId(userId),
          status: { $in: ['active', 'trial'] },
        })
        .select('planId status')
        .lean()
        .exec();
      const tier = (subForTier as { planId?: Types.ObjectId | string } | null)?.planId
        ? String((subForTier as { planId: Types.ObjectId | string }).planId)
        : 'free';

      this.postHog.identify({
        distinctId: userId,
        properties: { workspaceId: workspaceIdStr, tier },
      });
      this.postHog.capture({
        distinctId: userId,
        event: 'workspace.workspace_created',
        properties: { workspaceId: workspaceIdStr, tier },
      });

      return workspace;
    });
  }

  async findAllForUser(userId: string) {
    return this.withWorkspaceSpan('workspace.findAllForUser', { userId }, async () => {
      const owned = await this.workspaceModel
        .find({ ownerId: new Types.ObjectId(userId), isDeleted: { $ne: true } })
        .populate<{ ownerId: { isActive: boolean } }>('ownerId', 'isActive')
        .exec();

      const activeOwned = owned.filter((w) => {
        const owner = w.ownerId as unknown as { isActive?: boolean };
        return owner.isActive !== false;
      });

      const memberships = await this.memberModel
        .find({ userId: new Types.ObjectId(userId), status: 'active' })
        .populate({
          path: 'workspaceId',
          populate: { path: 'ownerId', select: 'isActive' },
        })
        .exec();

      const memberWorkspaces = memberships
        .map((m) => m.workspaceId)
        .filter((w) => {
          if (!w) return false;
          if ((w as any).isDeleted === true) return false;
          const owner = (w as any).ownerId as { isActive?: boolean } | undefined;
          return owner?.isActive !== false && !isWorkspaceOwner(w as any, userId);
        });

      return { owned: activeOwned, member: memberWorkspaces };
    });
  }

  async findById(workspaceId: string) {
    return this.withWorkspaceSpan('workspace.findById', { workspaceId }, async () => {
      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .populate<{
          ownerId: { isActive: boolean; name: string };
        }>('ownerId', 'isActive name')
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      // Soft-deleted workspaces are hidden from the user (spec: hide from every
      // user-facing read). A stale id / bookmark must not resurface a deleted
      // workspace's detail or members. This is the only user-facing caller of
      // findById; admin / recovery tooling (future) will read the model directly.
      if ((workspace as unknown as { isDeleted?: boolean }).isDeleted === true) {
        throw new NotFoundException('Workspace not found');
      }

      const owner = workspace.ownerId as unknown as {
        isActive?: boolean;
        name?: string;
      };
      if (owner.isActive === false) {
        throw new ForbiddenException('This workspace is currently unavailable.');
      }

      // OQ-W8 — never echo the SMTP credential in the workspace detail response.
      return this.stripSmtpSecret(workspace);
    });
  }

  /**
   * Soft-delete write guard (defence in depth). User-facing write methods call
   * this first so a stale workspace id can never mutate a hidden (soft-deleted)
   * workspace, including on a code path that bypasses RolesGuard's resolution.
   * Throws NotFound (same as a missing workspace) for an absent OR deleted row.
   * Admin / recovery tooling reads the model directly and must NOT call this.
   */
  private async assertWorkspaceNotDeleted(workspaceId: string): Promise<void> {
    const ws = await this.workspaceModel
      .findById(new Types.ObjectId(workspaceId))
      .select('isDeleted')
      .lean<{ isDeleted?: boolean }>()
      .exec();
    if (!ws || ws.isDeleted === true) {
      throw new NotFoundException('Workspace not found');
    }
  }

  async update(workspaceId: string, updateDto: UpdateWorkspaceDto): Promise<Workspace> {
    return this.withWorkspaceSpan('workspace.update', { workspaceId }, async () => {
      await this.assertWorkspaceNotDeleted(workspaceId);
      // Phase 24 D-10 (maintenanceLeadTimeDays) and Phase 25 D-07
      // (productionUptimeTargetPct) flow through this generic settings PATCH.
      // Explicit $set keeps the allowed fields auditable and avoids accidental
      // passthrough of unmodelled keys.
      const $set: Record<string, unknown> = { ...updateDto };
      if (updateDto.productionUptimeTargetPct !== undefined) {
        $set.productionUptimeTargetPct = updateDto.productionUptimeTargetPct;
      }
      // Designations backward-compat (F1, 2026-05-13): legacy callers may still
      // send `string[]`; normalise to `DesignationRecord[]` before persist.
      if (updateDto.designations !== undefined) {
        $set.designations = normalizeDesignationsForRead(updateDto.designations);
      }
      const workspace = await this.workspaceModel
        .findByIdAndUpdate(
          new Types.ObjectId(workspaceId),
          { $set },
          {
            new: true,
          },
        )
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      this.auditWorkspaceEvent({
        action: 'workspace.workspace_updated',
        workspaceId,
        actorId: workspace.ownerId,
        entityId: workspaceId,
        meta: { fieldsChanged: Object.keys(updateDto) },
      });

      return workspace;
    });
  }

  // ── Designations sub-resource (F1, 2026-05-13) ─────────────────────────────
  // Per-locale labels (en/gu-en/hi-en/gu), canonical-en key written to
  // `team_member.designation` (mobile-app contract preserved). Rename cascades
  // member references via single updateMany; delete blocks if any member uses
  // the designation (controller returns 409 with usage count for jump-to-team UX).

  async listDesignations(workspaceId: string): Promise<DesignationRecord[]> {
    const ws = await this.workspaceModel
      .findById(new Types.ObjectId(workspaceId))
      .select('designations isDeleted')
      .lean<{ designations?: unknown[]; isDeleted?: boolean }>()
      .exec();
    // Soft-deleted workspaces are hidden. This is the shared read for the
    // designation sub-resource, so add / rename / delete all fail closed here
    // before any `$set` write reaches a deleted workspace.
    if (!ws || ws.isDeleted === true) throw new NotFoundException('Workspace not found');
    return normalizeDesignationsForRead(ws.designations);
  }

  async addDesignation(
    workspaceId: string,
    dto: AddDesignationDto,
    actorId: string,
  ): Promise<DesignationRecord[]> {
    return this.withWorkspaceSpan(
      'workspace.designation_add',
      { workspaceId, userId: actorId },
      async (span) => {
        const current = await this.listDesignations(workspaceId);
        const candidate = dto.designation;
        const canonical = candidate.canonical.trim();
        if (!canonical) {
          throw new BadRequestException('Designation canonical label is required.');
        }
        const dup = current.some((d) => d.canonical.toLowerCase() === canonical.toLowerCase());
        if (dup) {
          throw new BadRequestException({
            success: false,
            code: 'DESIGNATION_DUPLICATE',
            message: `Designation "${canonical}" already exists in this workspace.`,
          });
        }
        const record: DesignationRecord = {
          canonical,
          isPreset: false,
          labels: {
            en: candidate.labels.en.trim() || canonical,
            ...(candidate.labels['gu-en']?.trim()
              ? { 'gu-en': candidate.labels['gu-en'].trim() }
              : {}),
            ...(candidate.labels['hi-en']?.trim()
              ? { 'hi-en': candidate.labels['hi-en'].trim() }
              : {}),
            ...(candidate.labels.gu?.trim() ? { gu: candidate.labels.gu.trim() } : {}),
          },
        };
        const next = [...current, record];
        await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { designations: next } },
            { new: false },
          )
          .exec();

        span?.setAttribute('designationCanonical', canonical);
        this.auditWorkspaceEvent({
          action: 'workspace.designation_added',
          workspaceId,
          actorId,
          entityId: workspaceId,
          meta: { canonical, isPreset: false },
        });
        this.postHog.capture({
          distinctId: actorId,
          event: 'workspace.designation_added',
          properties: { workspaceId, canonical },
        });
        return next;
      },
    );
  }

  /**
   * Renames a designation. Atomic-ish: workspace is updated first, then
   * `team_members.designation` strings are bulk-renamed via a single
   * updateMany. Mongo single-document atomicity is preserved for the workspace
   * write; the cascade is best-effort but driven by canonical match so a retry
   * is idempotent.
   */
  async renameDesignation(
    workspaceId: string,
    oldCanonical: string,
    dto: RenameDesignationDto,
    actorId: string,
  ): Promise<{
    designations: DesignationRecord[];
    cascadedMembers: number;
  }> {
    return this.withWorkspaceSpan(
      'workspace.designation_rename',
      { workspaceId, userId: actorId },
      async (span) => {
        const oldKey = oldCanonical.trim();
        const newKey = dto.newCanonical.trim();
        if (!oldKey || !newKey) {
          throw new BadRequestException('Old and new canonical labels are required.');
        }

        const current = await this.listDesignations(workspaceId);
        const idx = current.findIndex((d) => d.canonical.toLowerCase() === oldKey.toLowerCase());
        if (idx === -1) {
          throw new NotFoundException(`Designation "${oldKey}" not found in workspace.`);
        }

        // If renaming to a different key, ensure no collision with another existing entry.
        if (oldKey.toLowerCase() !== newKey.toLowerCase()) {
          const collision = current.some(
            (d, i) => i !== idx && d.canonical.toLowerCase() === newKey.toLowerCase(),
          );
          if (collision) {
            throw new BadRequestException({
              success: false,
              code: 'DESIGNATION_DUPLICATE',
              message: `Designation "${newKey}" already exists in this workspace.`,
            });
          }
        }

        const updated: DesignationRecord = {
          canonical: newKey,
          isPreset: current[idx].isPreset,
          labels: {
            en: dto.labels?.en?.trim() || newKey,
            ...(dto.labels?.['gu-en']?.trim()
              ? { 'gu-en': dto.labels['gu-en'].trim() }
              : current[idx].labels['gu-en']
                ? { 'gu-en': current[idx].labels['gu-en'] }
                : {}),
            ...(dto.labels?.['hi-en']?.trim()
              ? { 'hi-en': dto.labels['hi-en'].trim() }
              : current[idx].labels['hi-en']
                ? { 'hi-en': current[idx].labels['hi-en'] }
                : {}),
            ...(dto.labels?.gu?.trim()
              ? { gu: dto.labels.gu.trim() }
              : current[idx].labels.gu
                ? { gu: current[idx].labels.gu }
                : {}),
          },
        };

        const next = [...current];
        next[idx] = updated;

        await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { designations: next } },
            { new: false },
          )
          .exec();

        let cascadedMembers = 0;
        if (oldKey !== newKey) {
          const teamMemberModel = this.memberModel.db.model('TeamMember');
          const cascadeResult = (await teamMemberModel
            .updateMany(
              {
                workspaceId: new Types.ObjectId(workspaceId),
                designation: oldKey,
              },
              { $set: { designation: newKey } },
            )
            .exec()) as { modifiedCount?: number; nModified?: number };
          cascadedMembers = cascadeResult.modifiedCount ?? cascadeResult.nModified ?? 0;
        }

        span?.setAttribute('designationOldCanonical', oldKey);
        span?.setAttribute('designationNewCanonical', newKey);
        span?.setAttribute('cascadedMembers', cascadedMembers);
        this.auditWorkspaceEvent({
          action: 'workspace.designation_renamed',
          workspaceId,
          actorId,
          entityId: workspaceId,
          meta: { oldCanonical: oldKey, newCanonical: newKey, cascadedMembers },
        });
        this.postHog.capture({
          distinctId: actorId,
          event: 'workspace.designation_renamed',
          properties: { workspaceId, oldCanonical: oldKey, newCanonical: newKey, cascadedMembers },
        });

        return { designations: next, cascadedMembers };
      },
    );
  }

  /**
   * Counts how many team members currently reference a designation by canonical
   * en label. Used by the web UI to (a) drive a confirmation summary before
   * rename and (b) block deletion when in use.
   */
  async getDesignationUsage(
    workspaceId: string,
    canonical: string,
  ): Promise<{ canonical: string; inUseCount: number; sampleMemberIds: string[] }> {
    const key = canonical.trim();
    if (!key) throw new BadRequestException('Canonical label is required.');
    const teamMemberModel = this.memberModel.db.model('TeamMember');
    const count = await teamMemberModel
      .countDocuments({ workspaceId: new Types.ObjectId(workspaceId), designation: key })
      .exec();
    const sample = await teamMemberModel
      .find({ workspaceId: new Types.ObjectId(workspaceId), designation: key })
      .select('_id')
      .limit(5)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return {
      canonical: key,
      inUseCount: count,
      sampleMemberIds: sample.map((m) => String(m._id)),
    };
  }

  async deleteDesignation(
    workspaceId: string,
    canonical: string,
    actorId: string,
  ): Promise<DesignationRecord[]> {
    return this.withWorkspaceSpan(
      'workspace.designation_delete',
      { workspaceId, userId: actorId },
      async (span) => {
        const key = canonical.trim();
        if (!key) throw new BadRequestException('Canonical label is required.');

        const current = await this.listDesignations(workspaceId);
        const idx = current.findIndex((d) => d.canonical.toLowerCase() === key.toLowerCase());
        if (idx === -1) {
          throw new NotFoundException(`Designation "${key}" not found in workspace.`);
        }

        const usage = await this.getDesignationUsage(workspaceId, current[idx].canonical);
        if (usage.inUseCount > 0) {
          throw new BadRequestException({
            success: false,
            code: 'DESIGNATION_IN_USE',
            message: `${usage.inUseCount} member(s) are still using "${current[idx].canonical}". Reassign or remove them first.`,
            inUseCount: usage.inUseCount,
            sampleMemberIds: usage.sampleMemberIds,
            canonical: current[idx].canonical,
          });
        }

        const next = current.filter((_, i) => i !== idx);
        await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { designations: next } },
            { new: false },
          )
          .exec();

        span?.setAttribute('designationCanonical', current[idx].canonical);
        this.auditWorkspaceEvent({
          action: 'workspace.designation_deleted',
          workspaceId,
          actorId,
          entityId: workspaceId,
          meta: { canonical: current[idx].canonical, wasPreset: current[idx].isPreset },
        });
        this.postHog.capture({
          distinctId: actorId,
          event: 'workspace.designation_deleted',
          properties: { workspaceId, canonical: current[idx].canonical },
        });
        return next;
      },
    );
  }

  async remove(workspaceId: string, requestUserId: string): Promise<void> {
    return this.withWorkspaceSpan(
      'workspace.remove',
      { workspaceId, userId: requestUserId },
      async () => {
        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .exec();

        if (!workspace) {
          throw new NotFoundException('Workspace not found');
        }

        if (!isWorkspaceOwner(workspace, requestUserId)) {
          throw new ForbiddenException('Only the workspace owner can delete this workspace');
        }

        // Deleting your ONLY / last workspace is now allowed (owner-approved
        // behaviour change). The old `workspaceCount <= 1` BadRequestException was
        // obsolete and a real dead-end: the access model already supports a user
        // with zero workspaces (Connect stays open; the ERP area sends them to
        // /auth/setup-workspace), and there is NO ≥1-workspace invariant in the
        // data model (`User.hasWorkspace` is set on create but never enforced).
        // The owner check above still stands and the soft-delete + credential
        // scrub below is unchanged, so the row + all statutory data stay retained
        // and the workspace is recoverable for WORKSPACE_RESTORE_WINDOW_DAYS via
        // restore(). "Start fresh" is served by delete + create-new (a clean
        // slate; old data recoverable for 30 days) — no separate "clear data"
        // reset (a true wipe collides with statutory retention). The
        // delete-then-recreate-then-restore edge this opens is closed by the new
        // workspace-limit guard in restore().
        const wsOid = new Types.ObjectId(workspaceId);
        // User-side delete = soft-delete. The workspace and ALL its
        // workspace-scoped data (members, attendance, salary, files) are
        // retained, just hidden from the user. Physical erase is admin-only /
        // a future milestone. See MODULE-PLAYBOOK pattern 17.
        //
        // Workspaces hardening DEL-1 / AC-1.1 / AC-1.3 — in the SAME atomic write
        // that hides the workspace, IMMEDIATELY scrub the live credentials. These
        // are Bucket-C secrets with NO retention basis and a real exposure risk
        // if left live on a hidden workspace:
        //   - kioskTokenHash + kioskAllowedIpRanges + kioskTokenRotatedAt — a
        //     physical kiosk device bypasses JWT, so a still-valid token on a
        //     deleted workspace could keep punching. Nulling the bcrypt hash makes
        //     every kiosk-auth bcrypt.compare fail closed (= disabled).
        //   - attendanceIngestToken + attendanceIngestTokenRotatedAt — an unattended
        //     ingest device could keep posting punches; null the API credential.
        //   - emailConfig.smtpConfig.pass — outbound SMTP credential; no basis once
        //     the workspace is gone (OQ-W8). Other emailConfig fields (host/port/
        //     user/fromEmail) are operational and scrubbed later with the grace
        //     window by the retention cron, not here.
        // Bucket-A identity (name/code/designations/bankAccounts/settings) and all
        // Bucket-B statutory rows are retained — the retention cron handles the
        // rest after the grace / last-B window.
        await this.workspaceModel
          .updateOne(
            { _id: wsOid },
            {
              $set: {
                isDeleted: true,
                deletedAt: new Date(),
                deletedBy: new Types.ObjectId(requestUserId),
                kioskTokenHash: null,
                kioskAllowedIpRanges: [],
                kioskTokenRotatedAt: null,
                attendanceIngestToken: null,
                attendanceIngestTokenRotatedAt: null,
                'emailConfig.smtpConfig.pass': null,
              },
            },
          )
          .exec();

        // Owner just lost a workspace: recompute their hasWorkspace flag so a
        // now workspace-less owner drops to false (-> routed to Connect, never
        // force-PIN'd). No-op if they still own another live workspace.
        await this.recomputeHasWorkspace(requestUserId);

        this.auditWorkspaceEvent({
          action: 'workspace.workspace_deleted',
          workspaceId: null,
          actorId: requestUserId,
          entityId: workspaceId,
          meta: { name: workspace.name },
        });

        this.postHog.capture({
          distinctId: requestUserId,
          event: 'workspace.workspace_deleted',
          properties: { workspaceId, name: workspace.name },
        });

        // ADR-0004 — cascade to Connect: clear the dangling ERP link on any
        // CompanyPage / Storefront that pointed at this now-deleted workspace.
        // Owner id = the workspace owner (the linked entity owner is resolved
        // by the listener). Fire-and-forget (the listener self-guards).
        this.emitWorkspaceDeleted(workspaceId, String(workspace.ownerId));
      },
    );
  }

  /**
   * Workspaces hardening OQ-W3 (approved Option A) — list the caller's
   * recently-deleted, still-restorable workspaces (deleted within the
   * `WORKSPACE_RESTORE_WINDOW_DAYS` undo window). Owner-only by construction:
   * filters on `ownerId === caller`, the same gate as delete. Drives the
   * "Deleted workspaces" recovery section the FE renders next pass. Older
   * soft-deletes are intentionally excluded (UI hides them; data still retained
   * for compliance — admin tooling can still recover them).
   */
  async listRestorableWorkspaces(requestUserId: string) {
    return this.withWorkspaceSpan(
      'workspace.listRestorable',
      { userId: requestUserId },
      async () => {
        const windowStart = new Date();
        windowStart.setDate(windowStart.getDate() - WORKSPACE_RESTORE_WINDOW_DAYS);

        const deleted = await this.workspaceModel
          .find({
            ownerId: new Types.ObjectId(requestUserId),
            isDeleted: true,
            deletedAt: { $gte: windowStart },
          })
          .select('name businessType branding deletedAt')
          .sort({ deletedAt: -1 })
          .lean<
            Array<{
              _id: Types.ObjectId;
              name: string;
              businessType?: string;
              branding?: { logo?: string };
              deletedAt?: Date;
            }>
          >()
          .exec();

        return deleted.map((w) => {
          const deletedAt = w.deletedAt ?? null;
          // Surface the hard cutoff so the FE can show "restorable until {date}"
          // without re-deriving the window constant.
          const restorableUntil = deletedAt
            ? new Date(deletedAt.getTime() + WORKSPACE_RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
            : null;
          return {
            id: String(w._id),
            name: w.name,
            businessType: w.businessType ?? null,
            logo: w.branding?.logo ?? null,
            deletedAt,
            restorableUntil,
          };
        });
      },
    );
  }

  /**
   * Workspaces hardening OQ-W3 (approved Option A) — restore a workspace the
   * caller soft-deleted within the undo window. Clears `isDeleted` / `deletedAt`
   * / `deletedBy` so the workspace becomes visible + writable again. Owner-only
   * (same gate as delete: the service re-checks `isWorkspaceOwner`). Rejects:
   *   - a workspace the caller does not own (403),
   *   - a workspace that is not soft-deleted (400 — nothing to restore),
   *   - a workspace deleted longer than the window ago (400 — past undo; the data
   *     is still retained for compliance but self-serve restore is closed).
   *
   * NOTE the scrubbed credentials (kiosk token, ingest token, SMTP password) are
   * NOT regenerated on restore — they were one-way invalidated at delete time and
   * the owner must reconfigure them, exactly as a fresh setup would. This is the
   * safe posture (a restored workspace must not silently reactivate a stale
   * physical-access token).
   */
  async restore(workspaceId: string, requestUserId: string) {
    return this.withWorkspaceSpan(
      'workspace.restore',
      { workspaceId, userId: requestUserId },
      async () => {
        // Read the model directly (NOT findById, which hides soft-deleted rows —
        // restore is the one user-facing path that must SEE a deleted workspace).
        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .exec();
        if (!workspace) {
          throw new NotFoundException('Workspace not found');
        }

        if (!isWorkspaceOwner(workspace, requestUserId)) {
          throw new ForbiddenException('Only the workspace owner can restore this workspace');
        }

        const ws = workspace as unknown as { isDeleted?: boolean; deletedAt?: Date | null };
        if (ws.isDeleted !== true) {
          throw new BadRequestException('This workspace is not deleted.');
        }

        const deletedAt = ws.deletedAt ?? null;
        const windowStart = new Date();
        windowStart.setDate(windowStart.getDate() - WORKSPACE_RESTORE_WINDOW_DAYS);
        if (!deletedAt || deletedAt < windowStart) {
          throw new BadRequestException({
            success: false,
            code: 'WORKSPACE_RESTORE_WINDOW_EXPIRED',
            message: `This workspace was deleted more than ${WORKSPACE_RESTORE_WINDOW_DAYS} days ago and can no longer be restored from here. Contact support to recover it.`,
          });
        }

        // Workspace-limit guard on restore (edge opened by allowing last-workspace
        // delete). Without it: delete your only workspace → create a replacement
        // (now at the 1-workspace limit) → restore the old one = 2 active on a
        // 1-limit plan, bypassing the create-time cap. Re-uses the SAME private
        // helpers create() gates on, so the limit semantics stay identical
        // (soft-deleted rows are excluded from the active count, so this row —
        // still soft-deleted here — is not double-counted). Unlimited plans
        // (limit === -1) skip the check. Navigable: the replacement workspace is
        // itself deletable/recoverable, so the owner can delete it and then
        // restore this one.
        const restoreLimit = await this.getWorkspaceLimit(requestUserId);
        const activeOwnedCount = await this.getCurrentWorkspaceCount(requestUserId);
        if (restoreLimit !== -1 && activeOwnedCount >= restoreLimit) {
          throw new BadRequestException({
            success: false,
            code: 'WORKSPACE_LIMIT_REACHED_ON_RESTORE',
            message: `You're at your plan's workspace limit. Delete a workspace or upgrade before restoring this one.`,
            limit: restoreLimit,
            current: activeOwnedCount,
          });
        }

        await this.workspaceModel
          .updateOne(
            { _id: workspace._id },
            { $set: { isDeleted: false, deletedAt: null, deletedBy: null } },
          )
          .exec();

        // Owner regained a live workspace: ensure hasWorkspace reads true again
        // (mirrors the remove() recompute; covers delete-last -> restore).
        await this.recomputeHasWorkspace(requestUserId);

        this.auditWorkspaceEvent({
          action: 'workspace.workspace_restored',
          workspaceId,
          actorId: requestUserId,
          entityId: workspaceId,
          meta: { name: workspace.name, deletedAt: deletedAt.toISOString() },
        });

        this.postHog.capture({
          distinctId: requestUserId,
          event: 'workspace.workspace_restored',
          properties: { workspaceId },
        });

        return { ok: true, workspaceId };
      },
    );
  }

  /**
   * Workspaces hardening OQ-W4 (approved Option B) — soft-delete every workspace
   * the given user still owns. Called by the account-erasure path BEFORE the User
   * is anonymized, so an erased owner never leaves a workspace orphaned (owner FK
   * pointing at a "Deleted user" stub, no one able to manage or delete it).
   *
   * Reuses the exact soft-delete write the `remove()` path performs (credential
   * scrub included) so a DPDP erasure honours the same anonymize-don't-delete
   * cascade. It deliberately does NOT enforce the "last workspace" guard (that
   * protects a live owner from deleting their only workspace; an erased account
   * keeps nothing) and does NOT re-check ownership-vs-caller (the admin erasure
   * path is the authority here). Idempotent: only non-deleted owned rows match.
   *
   * Returns the count soft-deleted for the erasure audit/summary.
   */
  async softDeleteAllOwnedForErasure(ownerUserId: string): Promise<{ softDeleted: number }> {
    return this.withWorkspaceSpan(
      'workspace.softDeleteAllOwnedForErasure',
      { userId: ownerUserId },
      async () => {
        if (!Types.ObjectId.isValid(ownerUserId)) {
          return { softDeleted: 0 };
        }
        const ownerOid = new Types.ObjectId(ownerUserId);
        const owned = await this.workspaceModel
          .find({ ownerId: ownerOid, isDeleted: { $ne: true } })
          .select('_id name')
          .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
          .exec();

        if (owned.length === 0) {
          return { softDeleted: 0 };
        }

        const now = new Date();
        // Single bulk write — soft-delete + the SAME credential scrub the
        // per-workspace remove() applies (kiosk token, ingest token, SMTP
        // password). `deletedBy` = the owner being erased (the action is on their
        // behalf); the admin actor is captured separately in the erasure audit.
        await this.workspaceModel
          .updateMany(
            { ownerId: ownerOid, isDeleted: { $ne: true } },
            {
              $set: {
                isDeleted: true,
                deletedAt: now,
                deletedBy: ownerOid,
                kioskTokenHash: null,
                kioskAllowedIpRanges: [],
                kioskTokenRotatedAt: null,
                attendanceIngestToken: null,
                attendanceIngestTokenRotatedAt: null,
                'emailConfig.smtpConfig.pass': null,
              },
            },
          )
          .exec();

        for (const w of owned) {
          this.auditWorkspaceEvent({
            action: 'workspace.workspace_deleted',
            workspaceId: null,
            actorId: ownerUserId,
            entityId: String(w._id),
            meta: { name: w.name, reason: 'owner_account_erased' },
          });
          // ADR-0004 — cascade to Connect per workspace: an erased owner's
          // workspaces may be linked from OTHER users' entities; the listener
          // clears those dangling links too. (The erased user's own entities are
          // handled separately by `ConnectProfileService.handleAccountErased`.)
          this.emitWorkspaceDeleted(w._id, ownerUserId);
        }

        this.logger.log(
          `softDeleteAllOwnedForErasure owner=${ownerUserId} softDeleted=${owned.length}`,
        );

        return { softDeleted: owned.length };
      },
    );
  }

  /**
   * Account-deletion Phase 4 — Scope-2 "Delete ERP" soft phase (plan §3B). Tears
   * down the user's ENTIRE ERP footprint, reversibly:
   *   - owned workspaces → {@link softDeleteAllOwnedForErasure} (soft-delete +
   *     credential scrub; the 30-day per-workspace restore window is the recovery
   *     anchor);
   *   - non-owner memberships → {@link offboardAllMembershipsForErasure} (routed
   *     through the worker-offboard cascade so a linked worker's kiosk PIN etc.
   *     are scrubbed — NOT bare leaveWorkspace, plan §A.9);
   *   - then recompute `hasWorkspace` so a now workspace-less user is routed to
   *     Connect and never force-PIN'd (softDeleteAllOwnedForErasure does not, as
   *     its only other caller — eraseAccount — anonymizes the user right after).
   *
   * The account itself (User identity, Connect, sessions) is untouched — Scope 2
   * keeps the person; only the ERP box is removed.
   */
  async softDeleteErpForErasure(
    userId: string,
  ): Promise<{ ownedSoftDeleted: number; membershipsOffboarded: number }> {
    const owned = await this.softDeleteAllOwnedForErasure(userId);
    const member = await this.offboardAllMembershipsForErasure(userId);
    if (Types.ObjectId.isValid(userId)) {
      await this.recomputeHasWorkspace(userId);
    }
    return { ownedSoftDeleted: owned.softDeleted, membershipsOffboarded: member.offboarded };
  }

  /**
   * Offboard the user from every workspace they are an active NON-owner member of,
   * routing each through {@link removeMember} with `allowSelf` (the worker-offboard
   * cascade: TeamService.remove → salary pause + attendance kiosk-PIN scrub for a
   * linked worker; access-revoke-only for a bare collaborator). Owned workspaces
   * are skipped (handled by softDeleteAllOwnedForErasure) as are already-deleted
   * ones. Per-membership fault-isolated: one failure never aborts the rest.
   */
  async offboardAllMembershipsForErasure(userId: string): Promise<{ offboarded: number }> {
    if (!Types.ObjectId.isValid(userId)) return { offboarded: 0 };
    const memberships = await this.memberModel
      .find({ userId: new Types.ObjectId(userId), status: 'active' })
      .populate('workspaceId', 'ownerId isDeleted name')
      .exec();

    let offboarded = 0;
    for (const m of memberships) {
      const ws = m.workspaceId as unknown as {
        _id?: Types.ObjectId;
        ownerId?: Types.ObjectId;
        isDeleted?: boolean;
      } | null;
      // Skip a dangling membership, an already-deleted workspace, or one the user
      // OWNS (softDeleteAllOwnedForErasure handles owned workspaces wholesale).
      if (!ws?._id || ws.isDeleted === true || isWorkspaceOwner(ws, userId)) continue;
      try {
        await this.removeMember(String(ws._id), String(m._id), userId, { allowSelf: true });
        offboarded++;
      } catch (err) {
        this.logger.warn(
          `offboardAllMembershipsForErasure: offboard failed user=${userId} ws=${String(
            ws._id,
          )} member=${String(m._id)} (continuing): ${(err as Error)?.message ?? err}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'workspaces', op: 'offboardAllMembershipsForErasure' },
          extra: { userId, workspaceId: String(ws._id), memberId: String(m._id) },
        });
      }
    }
    return { offboarded };
  }

  /**
   * Account-deletion Phase 4 — the Scope-2 warning topology (plan §3B "B2"): the
   * owned workspaces (with the team-member count that loses access) + the member
   * workspaces the user will be offboarded from. The caller (AccountDeletionService)
   * layers the open employer-loan / unpaid-advance flags on top. Read-only.
   */
  async getErpDeletionImpact(userId: string): Promise<{
    owned: Array<{ workspaceId: string; name: string; memberCount: number }>;
    member: Array<{ workspaceId: string; name: string }>;
  }> {
    if (!Types.ObjectId.isValid(userId)) return { owned: [], member: [] };
    const ownerOid = new Types.ObjectId(userId);

    const ownedDocs = await this.workspaceModel
      .find({ ownerId: ownerOid, isDeleted: { $ne: true } })
      .select('_id name')
      .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
      .exec();

    const owned: Array<{ workspaceId: string; name: string; memberCount: number }> = [];
    for (const w of ownedDocs) {
      // Active members EXCLUDING the owner's own row = the team that loses access.
      const memberCount = await this.memberModel
        .countDocuments({ workspaceId: w._id, status: 'active', userId: { $ne: ownerOid } })
        .exec();
      owned.push({ workspaceId: String(w._id), name: w.name ?? '', memberCount });
    }

    const memberships = await this.memberModel
      .find({ userId: ownerOid, status: 'active' })
      .populate('workspaceId', 'ownerId isDeleted name')
      .exec();
    const member: Array<{ workspaceId: string; name: string }> = [];
    for (const m of memberships) {
      const ws = m.workspaceId as unknown as {
        _id?: Types.ObjectId;
        ownerId?: Types.ObjectId;
        isDeleted?: boolean;
        name?: string;
      } | null;
      if (!ws?._id || ws.isDeleted === true || isWorkspaceOwner(ws, userId)) continue;
      member.push({ workspaceId: String(ws._id), name: ws.name ?? '' });
    }

    return { owned, member };
  }

  /**
   * Account-deletion Phase 4 — admin-mediated recovery of the Scope-2 soft phase
   * (plan §3B). Best-effort restore of every owned workspace soft-deleted by the
   * deletion (anchored on `since` = the deletion's requestedAt, so manually-deleted
   * workspaces from before the schedule are left alone), reusing the existing
   * {@link restore} (which enforces the per-workspace 30-day window + plan limit
   * and yields the real error codes). Member workspaces are NOT auto-rejoinable —
   * the user must be re-invited (the caller reflects that in the response/copy).
   */
  async restoreAllOwnedForRecovery(
    userId: string,
    since?: Date,
  ): Promise<{ restored: string[]; failed: Array<{ workspaceId: string; code?: string }> }> {
    if (!Types.ObjectId.isValid(userId)) return { restored: [], failed: [] };
    const filter: Record<string, unknown> = {
      ownerId: new Types.ObjectId(userId),
      isDeleted: true,
    };
    if (since) filter.deletedAt = { $gte: since };

    const deleted = await this.workspaceModel
      .find(filter)
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();

    const restored: string[] = [];
    const failed: Array<{ workspaceId: string; code?: string }> = [];
    for (const w of deleted) {
      const wsId = String(w._id);
      try {
        await this.restore(wsId, userId);
        restored.push(wsId);
      } catch (err) {
        const code = (err as { response?: { code?: string } })?.response?.code;
        this.logger.warn(
          `restoreAllOwnedForRecovery: restore failed user=${userId} ws=${wsId} code=${
            code ?? 'unknown'
          } (continuing)`,
        );
        failed.push({ workspaceId: wsId, code });
      }
    }
    return { restored, failed };
  }

  /**
   * Workspaces hardening OQ-W6 (approved Option C) — self-serve "Leave workspace"
   * for a NON-owner member. This is the deliberate exception to the
   * "Cannot remove yourself" block in removeMember: a member who was added
   * (including silently via `autoAcceptKnownInvites`) must always have an exit.
   *
   * Guards:
   *   - the workspace owner can NEVER leave (ownership is immutable; they must
   *     delete or transfer instead) — returns 400.
   *   - only an ACTIVE membership for THIS caller in THIS workspace can be left.
   *
   * Effect mirrors removeMember's access-side teardown for the caller's own row:
   * status='removed' + Redis denylist + session-revoke signal, scoped to this one
   * workspace (the person is untouched in any other workspace). It does NOT fire
   * the salary/attendance offboarding cascade — leaving is the member's own
   * choice, not an employer offboard; their employment records (if any) are an
   * employer decision to settle via the Team directory.
   */
  async leaveWorkspace(workspaceId: string, requestUserId: string) {
    return this.withWorkspaceSpan(
      'workspace.leaveWorkspace',
      { workspaceId, userId: requestUserId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);

        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .select('ownerId name')
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');

        // The owner cannot leave their own workspace (immutable ownership).
        if (isWorkspaceOwner(workspace, requestUserId)) {
          throw new BadRequestException(
            'The workspace owner cannot leave. Delete or transfer the workspace instead.',
          );
        }

        const member = await this.memberModel
          .findOne({
            workspaceId: new Types.ObjectId(workspaceId),
            userId: new Types.ObjectId(requestUserId),
            status: 'active',
          })
          .exec();
        if (!member) {
          throw new NotFoundException('You are not an active member of this workspace.');
        }

        member.status = 'removed';
        member.removedAt = new Date();
        // Self-initiated: the actor IS the member.
        member.removedBy = new Types.ObjectId(requestUserId);
        // OQ-W2 — scrub any lingering invitee PII on the now-removed row.
        member.inviteeIdentifier = undefined;
        member.inviteeType = undefined;
        await member.save();

        // Revoke this caller's access to THIS workspace only (Redis denylist +
        // kill their active sessions for this workspace). Scoped by
        // (workspaceId, userId) so other workspaces are untouched.
        await this.revocationService.revoke(workspaceId, requestUserId);
        await this.killWorkspaceSessions(workspaceId, requestUserId);

        this.auditWorkspaceEvent({
          action: 'workspace.member_left',
          workspaceId,
          actorId: requestUserId,
          entityType: 'workspace_member',
          entityId: member._id,
          meta: { self: true },
        });

        this.postHog.capture({
          distinctId: requestUserId,
          event: 'workspace.member_left',
          properties: { workspaceId },
        });

        return { ok: true };
      },
    );
  }

  /**
   * Revoke the given user's active sessions scoped to ONE workspace (mirrors the
   * session-kill TeamService.revokeAccess performs). Resolved lazily via the
   * member model's connection so we avoid injecting the Session model into this
   * service. Best-effort: a session-kill failure must not roll back the primary
   * membership write (the Redis denylist already fails the next request closed).
   */
  private async killWorkspaceSessions(workspaceId: string, userId: string): Promise<void> {
    try {
      const sessionModel = this.memberModel.db.model('Session');
      await sessionModel
        .updateMany(
          {
            userId: new Types.ObjectId(userId),
            workspaceId: new Types.ObjectId(workspaceId),
            isActive: true,
          },
          { $set: { isActive: false } },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `killWorkspaceSessions failed ws=${workspaceId} user=${userId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  async getMembers(workspaceId: string): Promise<any[]> {
    return this.withWorkspaceSpan('workspace.getMembers', { workspaceId }, async () => {
      const members = await this.memberModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          // RBAC Remediation Tier 1 (2026-05-18): previously `{ $ne: 'declined' }`
          // which returned PII for removed/suspended ex-members. Now limited to
          // active + invited only — active members are current team; invited members
          // are pending-acceptance invites that a Manager/HR legitimately manages
          // (resend / cancel). Removed / suspended / declined are excluded.
          status: { $in: ['active', 'invited'] },
        })
        .populate('userId', 'name email mobile profilePicture')
        .populate('roleId', 'name')
        .exec();

      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .select('ownerId')
        .exec();

      const ownerId = workspace?.ownerId?.toString();

      return members.map((m: any) => {
        const userIdStr = m.userId
          ? typeof m.userId === 'object'
            ? m.userId._id?.toString()
            : m.userId.toString()
          : null;
        return {
          _id: m._id,
          userId: userIdStr,
          workspaceId: m.workspaceId,
          role: ownerId === userIdStr ? 'owner' : 'member',
          user: m.userId,
          status: m.status,
          inviteeIdentifier: m.inviteeIdentifier,
          inviteeType: m.inviteeType,
        };
      });
    });
  }

  async inviteMember(workspaceId: string, inviterId: string, inviteDto: InviteMemberDto) {
    return this.withWorkspaceSpan(
      'workspace.inviteMember',
      { workspaceId, userId: inviterId },
      async () => {
        const identifier = inviteDto.email || inviteDto.mobile;
        if (!identifier) {
          throw new BadRequestException('Email or mobile must be provided');
        }

        const isEmail = !!inviteDto.email;
        const user = isEmail
          ? await this.usersService.findByIdentifier(inviteDto.email)
          : await this.usersService.findByIdentifier(inviteDto.mobile);

        // Check seat limit
        await this.checkSeatLimit(workspaceId);

        // P1.8-revert.11 + .17 (2026-05-14) — pre-check the linked-team-
        // member bridge BEFORE the userId / identifier conflict checks.
        // Routes the same Grant click to one of four outcomes:
        //   - 'active'   → hard throw (revoke first)
        //   - 'invited'  → heal: rotate token in place
        //   - 'removed' / 'declined' → resurrect: clear removedAt /
        //     removedBy / declinedAt, status='invited', rotate token,
        //     refresh identifier + userId. Without resurrection the
        //     existing-userId row collides with the partial-unique
        //     index `(workspaceId, userId)` on the new insert, throwing
        //     E11000 even though the prior membership was already
        //     terminated.
        let healTeamMemberBridge: any = null;
        if (inviteDto.teamMemberId) {
          const candidate = await this.memberModel
            .findOne({
              workspaceId: new Types.ObjectId(workspaceId),
              linkedTeamMemberId: new Types.ObjectId(inviteDto.teamMemberId),
              status: { $in: ['active', 'invited', 'removed', 'declined'] },
            })
            .sort({ updatedAt: -1 })
            .exec();
          if (candidate) {
            if (candidate.status === 'active') {
              throw new BadRequestException(
                'This team member already has active access. Revoke first to re-invite.',
              );
            }
            healTeamMemberBridge = candidate;
          }
        }

        // §10c.1 (AC-10.1) — collaborator-path heal. On the email/mobile invite
        // path (no linked team member), a prior 'removed'/'declined' row for the
        // resolved User was previously INVISIBLE to the existence check below
        // (it matched only ['active','invited']), so a SECOND row was inserted.
        // Once the re-added collaborator accepts and userId binds, two rows share
        // (workspaceId, userId) → E11000 on the partial-unique index. Fix: detect
        // the prior terminal-state row here and HEAL it in place (mirror the
        // worker-path resurrection), so one person keeps exactly one membership row
        // and their history stays intact.
        let healCollaboratorBridge: any = null;
        // §10c.2 (AC-10.3) — rehire signal. Capture the prior removed/declined
        // membership (if any) for the resolved User so the response can tell the
        // FE "this person was a member here (removed on {date})" before confirming.
        let priorMembership: { removedAt: Date | null; declinedAt: Date | null } | null = null;

        // Conflict checks only apply when we are not healing an existing
        // bridge for the SAME teamMember — otherwise userId/identifier
        // hits would point at the very row we are about to rotate.
        if (!healTeamMemberBridge) {
          if (user) {
            const existing = await this.memberModel.findOne({
              workspaceId: new Types.ObjectId(workspaceId),
              userId: new Types.ObjectId(user._id),
              status: { $in: ['active', 'invited'] },
            });
            if (existing) {
              if (existing.status === 'invited') {
                throw new BadRequestException('User is already invited');
              }
              throw new BadRequestException('User is already a member');
            }

            // No active/invited row — look for a prior terminal-state row for this
            // User to reattach to (and to surface the rehire notice). Excludes
            // worker-linked rows: those flow through the teamMemberId heal path
            // above, and a re-add there should reattach to the SAME directory
            // employee, not a bare-collaborator row.
            const priorRow = await this.memberModel
              .findOne({
                workspaceId: new Types.ObjectId(workspaceId),
                userId: new Types.ObjectId(user._id),
                status: { $in: ['removed', 'declined'] },
                linkedTeamMemberId: null,
              })
              .sort({ updatedAt: -1 })
              .exec();
            if (priorRow) {
              healCollaboratorBridge = priorRow;
              priorMembership = {
                removedAt: priorRow.removedAt ?? null,
                declinedAt: priorRow.declinedAt ?? null,
              };
            }
          }

          // Only guard the identifier-collision when we are NOT healing a prior
          // collaborator row (a heal targets the very row a stale identifier match
          // would point at). The 'invited' filter already excludes terminal rows.
          if (!healCollaboratorBridge) {
            const existingByIdentifier = await this.memberModel.findOne({
              workspaceId: new Types.ObjectId(workspaceId),
              inviteeIdentifier: identifier,
              status: 'invited',
            });
            if (existingByIdentifier) {
              throw new BadRequestException('This email/mobile is already invited');
            }
          }
        }

        // Generate token and hash
        const rawToken = crypto.randomBytes(32).toString('hex');
        const inviteTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const inviteExpiry = new Date();
        inviteExpiry.setDate(inviteExpiry.getDate() + 7);

        const inviteUrl = `${this.webAppUrl}/invite?token=${rawToken}&type=workspace`;
        const mobileDeepLink = `${this.mobileDeepLink}/${rawToken}`;

        // Get inviter name
        const inviter = await this.usersService.findById(inviterId);
        const inviterName = inviter?.name || 'Someone';

        // Get workspace info
        const workspace = await this.workspaceModel.findById(workspaceId).exec();
        const workspaceName = workspace?.name || 'a workspace';

        // Get role name
        let roleName = 'Member';
        if (inviteDto.roleId) {
          const roleModel = this.memberModel.db.model('Role');
          const role = await roleModel.findById(inviteDto.roleId).lean().exec();
          roleName = (role as any)?.name || 'Member';
        }

        // Wave 2 invite consolidation — when teamMemberId is set, this invite
        // is linked to a directory employee (replaces team.grantAccess flow).
        // The bridge row holds the canonical role + token; on accept, the
        // linked TeamMember gets hasAppAccess=true + linkedUserId set.
        const linkedTeamMemberId: Types.ObjectId | null = inviteDto.teamMemberId
          ? new Types.ObjectId(inviteDto.teamMemberId)
          : null;

        // P1.8-revert.11 + .17 (2026-05-14) — heal / resurrect path:
        // rotate the existing bridge row's token / hash / expiry / role
        // / identifier in-place. For previously-removed or -declined
        // rows, also clear the terminal-state fields (removedAt /
        // removedBy / declinedAt) and flip status back to 'invited'.
        // Owner gets a fresh shareable link without us creating a
        // duplicate bridge row that would collide on the partial-
        // unique (workspaceId, userId) index.
        let member: any;
        if (healTeamMemberBridge) {
          // §10c.2 (AC-10.3) — worker-path rehire signal. If the bridge we are
          // resurrecting was in a terminal state, surface it so the FE shows the
          // "previously a member (removed on {date})" notice before confirming.
          if (
            healTeamMemberBridge.status === 'removed' ||
            healTeamMemberBridge.status === 'declined'
          ) {
            priorMembership = {
              removedAt: healTeamMemberBridge.removedAt ?? null,
              declinedAt: healTeamMemberBridge.declinedAt ?? null,
            };
          }
          healTeamMemberBridge.inviteTokenHash = inviteTokenHash;
          healTeamMemberBridge.inviteExpiry = inviteExpiry;
          healTeamMemberBridge.inviteeIdentifier = identifier;
          healTeamMemberBridge.inviteeType = isEmail ? 'email' : 'mobile';
          healTeamMemberBridge.status = 'invited';
          // Resurrection clears the terminal-state metadata so the row
          // looks like a fresh invite. removedBy / declinedAt history
          // lives in the audit log; the bridge row itself doesn't need
          // to keep the prior termination context once re-issued.
          healTeamMemberBridge.removedAt = undefined;
          healTeamMemberBridge.removedBy = undefined;
          healTeamMemberBridge.declinedAt = undefined;
          if (inviteDto.roleId) {
            healTeamMemberBridge.roleId = new Types.ObjectId(inviteDto.roleId);
          }
          // Match the User on re-grant. If owner has corrected the
          // member's identifier in the directory between revoke + re-
          // grant, the bridge's userId is rebound to the new matched
          // User (or cleared if no User matches the new identifier).
          healTeamMemberBridge.userId = user ? new Types.ObjectId(user._id) : null;
          healTeamMemberBridge.invitedBy = new Types.ObjectId(inviterId);
          await healTeamMemberBridge.save();
          member = healTeamMemberBridge;
        } else if (healCollaboratorBridge) {
          // §10c.1 (AC-10.1) — collaborator-path resurrection. Mirror the
          // worker-path heal above for a bare collaborator (no linkedTeamMemberId):
          // reactivate the SINGLE prior removed/declined row in place so a re-add
          // reattaches to it instead of inserting a duplicate that would collide on
          // the (workspaceId, userId) partial-unique index at accept time.
          healCollaboratorBridge.inviteTokenHash = inviteTokenHash;
          healCollaboratorBridge.inviteExpiry = inviteExpiry;
          healCollaboratorBridge.inviteeIdentifier = identifier;
          healCollaboratorBridge.inviteeType = isEmail ? 'email' : 'mobile';
          healCollaboratorBridge.status = 'invited';
          healCollaboratorBridge.removedAt = undefined;
          healCollaboratorBridge.removedBy = undefined;
          healCollaboratorBridge.declinedAt = undefined;
          healCollaboratorBridge.roleId = inviteDto.roleId
            ? new Types.ObjectId(inviteDto.roleId)
            : null;
          // userId already equals user._id (that's how we matched the row), but
          // rebind defensively so the row is unambiguously owned by this User.
          healCollaboratorBridge.userId = user ? new Types.ObjectId(user._id) : null;
          healCollaboratorBridge.invitedBy = new Types.ObjectId(inviterId);
          await healCollaboratorBridge.save();
          member = healCollaboratorBridge;
        } else {
          member = new this.memberModel({
            workspaceId: new Types.ObjectId(workspaceId),
            userId: user ? new Types.ObjectId(user._id) : null,
            roleId: inviteDto.roleId ? new Types.ObjectId(inviteDto.roleId) : null,
            status: 'invited',
            invitedBy: new Types.ObjectId(inviterId),
            inviteTokenHash,
            inviteExpiry,
            inviteeIdentifier: identifier,
            inviteeType: isEmail ? 'email' : 'mobile',
            linkedTeamMemberId,
          });
          await member.save();
        }

        // Wave 2 — back-reference TeamMember → WorkspaceMember + dual-write
        // the invite-token fields used by team.service.toResponse to compute
        // `appAccessStatus`. Without this dual-write the rail stays in 'none'
        // state visually even though the WorkspaceMember bridge row exists
        // (P1.8-revert.10, 2026-05-14). `hasAppAccess` stays false — flipped
        // to true on accept (atomic with WorkspaceMember.status='active').
        // `rbacRoleId` is mirrored so the rail can render the chosen role
        // immediately while the invite is pending.
        if (linkedTeamMemberId) {
          const teamMemberModel = this.memberModel.db.model('TeamMember');
          await teamMemberModel
            .updateOne(
              { _id: linkedTeamMemberId },
              {
                $set: {
                  linkedWorkspaceMemberId: member._id,
                  appAccessInviteToken: rawToken,
                  appAccessInviteTokenHash: inviteTokenHash,
                  appAccessInviteExpiry: inviteExpiry,
                  ...(inviteDto.roleId ? { rbacRoleId: new Types.ObjectId(inviteDto.roleId) } : {}),
                },
              },
            )
            .exec();
        }

        // OQ-W6 (approved Option C) — `autoAcceptKnownInvites`. When the owner has
        // opted into frictionless onboarding AND the invitee is an existing warm
        // User AND this is a bare collaborator invite (no directory employee link),
        // flip the membership straight to 'active' without requiring the invitee to
        // click Accept. Scoped deliberately narrow: worker (linkedTeamMemberId) and
        // cold (no User) invites are EXCLUDED — the worker path has its own
        // accept-time TeamMember link flip, and a cold invite's signup IS the
        // consent. Because this bypasses the invitee's explicit click, Option C
        // REQUIRES we (a) notify them immediately with a one-tap "Leave" path
        // (leaveWorkspace) and (b) never silently retain them — the consent gap is
        // closed by informing + offering an exit, not by removing the feature.
        let autoAccepted = false;
        if (
          user &&
          !linkedTeamMemberId &&
          member.status === 'invited' &&
          (workspace as unknown as { autoAcceptKnownInvites?: boolean })?.autoAcceptKnownInvites ===
            true
        ) {
          member.status = 'active';
          member.inviteTokenHash = undefined;
          member.inviteExpiry = undefined;
          member.inviteToken = undefined;
          member.inviteeIdentifier = undefined;
          member.inviteeType = undefined;
          member.joinedAt = new Date();
          await member.save();
          // Clear any stale denylist entry so the auto-added member is not blocked
          // by a prior revocation (lifecycle L8 parity with the accept paths).
          await this.revocationService.clear(workspaceId, String(user._id));
          autoAccepted = true;

          // Consent notice — fire-and-forget; a notification failure must not roll
          // back the (already-committed) membership.
          try {
            await this.notificationsService.createNotification(workspaceId, {
              recipientId: String(user._id),
              type: 'warning',
              title: `You were added to ${workspaceName}`,
              message: `${inviterName} added you to ${workspaceName}. If you did not intend to join, you can leave from your workspaces list.`,
              metadata: {
                category: 'WORKSPACE_AUTO_ADDED',
                workspaceId,
                workspaceMemberId: String(member._id),
              },
            });
          } catch (e) {
            this.logger.error(
              `auto-accept consent notification failed ws=${workspaceId} user=${String(
                user._id,
              )}: ${(e as Error)?.message ?? e}`,
            );
          }
        }

        // P1.5 (2026-05-14) — sendMethod parity with legacy grantAccess:
        // 'link' suppresses email + SMS (in-app notification still fires
        // for known users so the inbox surface stays populated). The
        // raw token is returned to the caller so the owner can copy/share
        // manually. 'auto' / 'both' / undefined → existing behaviour.
        // When auto-accepted there is no pending invite to deliver — skip the
        // invite dispatch entirely (the consent notice above already informed the
        // member); the membership is already active.
        const sendMethod = inviteDto.sendMethod ?? 'auto';

        // P1.8-revert.10 (2026-05-14) — dispatch is best-effort. The
        // WorkspaceMember row is already persisted; a notification /
        // email / SMS failure must NOT throw out of this method, or
        // the caller will see an error toast while the underlying
        // grant succeeded (ghost state — retry blocks on "already
        // invited"). Errors are surfaced via Sentry inside the
        // dispatcher; we additionally swallow at the boundary so the
        // happy path always returns a token.
        if (!autoAccepted) {
          try {
            await this.inviteDispatcher.dispatch({
              workspaceId,
              workspaceName,
              inviterName,
              inviteeIdentifier: identifier,
              inviteeType: isEmail ? 'email' : 'mobile',
              inviteeUserId: user?._id?.toString(),
              inviteeEmail: user?.email,
              sendMethod,
              // P2.0.2 (2026-05-15) — forward per-channel selection if the
              // caller supplied it. Dispatcher treats channels[] as
              // authoritative; legacy callers without it fall through to
              // sendMethod semantics.
              channels: inviteDto.channels,
              role: roleName,
              inviteUrl,
              mobileDeepLink,
            });
          } catch (e) {
            this.logger.error(
              `Invite dispatch failed for ${identifier}: ${(e as Error)?.message ?? e}`,
            );
          }
        }

        this.auditWorkspaceEvent({
          action: autoAccepted ? 'workspace.member_auto_added' : 'workspace.member_invited',
          workspaceId,
          actorId: inviterId,
          actorNameSnapshot: inviterName,
          entityType: 'workspace_member',
          entityId: member._id,
          meta: {
            inviteeType: isEmail ? 'email' : 'mobile',
            inviteeIdentifier: identifier,
            autoAccepted,
          },
        });

        this.postHog.capture({
          distinctId: inviterId,
          event: 'workspace.member_invited',
          properties: {
            workspaceId,
            autoAccepted,
            inviteeType: isEmail ? 'email' : 'mobile',
          },
        });

        // P1.8-revert.10 (2026-05-14) — always return the raw token. The
        // owner needs a manual shareable link as a fallback for every
        // grant: SMS may be filtered, email may bounce, in-app
        // notifications may go unread, owner may want to ping via
        // WhatsApp. Industry standard (Slack / Asana / Linear / GitHub)
        // — invite UI always shows a copyable link alongside the
        // auto-delivery options. Token is single-use + 7-day TTL +
        // identifier-locked on accept, so surfacing it carries no
        // additional security cost.
        return {
          message: autoAccepted ? 'Member added' : 'Invitation sent',
          inviteToken: rawToken,
          // OQ-W6 — true when the invitee was auto-activated (no click needed) via
          // the owner's autoAcceptKnownInvites flag. Additive; lets the FE show
          // "added" rather than "invite sent" copy.
          autoAccepted,
          // §10c.2 (AC-10.3) — rehire signal. Present (non-null) only when this
          // invite reattached to a prior removed/declined membership for the same
          // person. Additive — existing callers that ignore it are unaffected; the
          // FE uses it to render the "previously a member (removed on {date})"
          // confirmation notice.
          priorMembership,
        };
      },
    );
  }

  private async checkSeatLimit(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceModel.findById(workspaceId).exec();
    // Soft-deleted workspaces are hidden from the user and must not accept new
    // members. inviteMember reaches this guard first, so a stale workspace id
    // can never seat a member into a deleted workspace.
    if (!workspace || (workspace as unknown as { isDeleted?: boolean }).isDeleted === true) {
      throw new NotFoundException('Workspace not found');
    }

    const subscription = await this.subscriptionModel
      .findOne({
        userId: workspace.ownerId,
        status: { $in: ['active', 'trial'] },
      })
      .select('appliedEntitlements')
      .lean()
      .exec();

    const perWorkspaceLimit = subscription?.appliedEntitlements?.maxMembersPerWorkspace ?? 5;
    const currentCount = await this.memberModel
      .countDocuments({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();

    if (perWorkspaceLimit !== -1 && currentCount >= perWorkspaceLimit) {
      throw new ForbiddenException({
        success: false,
        message: `Team member limit reached for this workspace. Your current plan allows up to ${perWorkspaceLimit} members per workspace.`,
        code: 'SEAT_LIMIT_REACHED',
        limit: perWorkspaceLimit,
        current: currentCount,
        upgradeUrl: '/subscription/upgrade',
      });
    }
  }

  async removeMember(
    workspaceId: string,
    memberId: string,
    requestUserId: string,
    options?: { allowSelf?: boolean },
  ) {
    return this.withWorkspaceSpan(
      'workspace.removeMember',
      { workspaceId, userId: requestUserId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        // OQ-W5 (cross-workspace hardening) — scope the lookup by
        // (memberId, workspaceId) so a memberId from ANOTHER workspace returns
        // 404 (not found) instead of leaking through to the owner-check 403. The
        // scoped query is the explicit defense-in-depth layer; it no longer relies
        // on the populate chain + owner comparison to reject cross-workspace ids.
        const member = await this.memberModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .populate('workspaceId')
          .exec();
        if (!member) throw new NotFoundException('Member not found');

        // The admin-UI self-removal block (use leaveWorkspace instead). DPDP
        // account-deletion Phase 4 (§3B) passes allowSelf:true so a self-deleting
        // user can offboard their OWN membership through this full worker cascade
        // — the path that scrubs a linked worker's kiosk PIN — rather than the
        // bare leaveWorkspace exit (which would leave Bucket-C credentials behind).
        if (!options?.allowSelf && member.userId && member.userId.toString() === requestUserId) {
          throw new BadRequestException('Cannot remove yourself');
        }

        const workspace: any = member.workspaceId;
        if (member.userId && isWorkspaceOwner(workspace, member.userId)) {
          throw new BadRequestException('Cannot remove workspace owner');
        }

        // Capture the linked directory employee BEFORE the save (the bridge row
        // keeps the FK; OQ-W1 cascade needs it).
        const linkedTeamMemberId = member.linkedTeamMemberId
          ? String(member.linkedTeamMemberId)
          : null;

        // Wave 2 W2.1 — soft-delete (status='removed') retains audit trail
        // for compliance + dispute resolution (locked decision #7). Re-grant
        // heals this row; it stays for history.
        member.status = 'removed';
        member.removedAt = new Date();
        member.removedBy = new Types.ObjectId(requestUserId);
        // OQ-W2 (AC-1.5) — scrub the invitee PII on the now-removed row. For a
        // member who was accepted these are already null; for a row removed while
        // still 'invited' (owner force-removes a pending invite) they would
        // otherwise linger as basis-less personal data on a removed row.
        member.inviteeIdentifier = undefined;
        member.inviteeType = undefined;
        await member.save();

        // Wave 2 W2.2 — push to Redis denylist so any in-flight JWT for this
        // user gets a strict 403 immediately (defense-in-depth alongside the
        // status='active' check on the membership lookup). Plus kill their active
        // sessions for THIS workspace (parity with TeamService.revokeAccess — a
        // Redis-only revoke left a live session usable until its next guard hit).
        if (member.userId) {
          await this.revocationService.revoke(workspaceId, String(member.userId));
          await this.killWorkspaceSessions(workspaceId, String(member.userId));
        }

        // OQ-W1 (approved Option A) — UNIFY the offboarding cascade. When this
        // membership is linked to a directory employee, fire the SAME full
        // offboarding cascade the Team directory remove fires, by routing through
        // TeamService.remove(): it soft-deletes the TeamMember and runs the salary
        // (pause schedules / cancel pending advances / alert open loans) +
        // attendance (immediate kiosk-PIN scrub) cascades. Without this, removing
        // via the Workspace page left active commission schedules, open advance
        // requests, and a live kiosk PIN behind — a real gap (spec §3a, OQ-W1).
        //
        // SAFETY: this only fires for a row with a linkedTeamMemberId. A bare
        // workspace collaborator (co-founder / accountant, no directory employee)
        // has NO salary/attendance records, so for them removeMember stays
        // access-revoke-only — firing an employment offboard on a non-employee
        // would be meaningless. "Revoke app access but keep the worker employed"
        // remains served by the separate Team `hasAppAccess` toggle
        // (TeamService.revokeAccess), which this does NOT touch.
        //
        // IDEMPOTENT: TeamService.remove() is a no-op if the TeamMember is already
        // soft-deleted, so a later Team-directory remove of the same person does
        // not double-process. Best-effort: a cascade failure must never roll back
        // the workspace-membership removal (access is already revoked above).
        if (linkedTeamMemberId) {
          try {
            const { TeamService: TeamServiceClass } = require('../team/team.service');
            const teamService = this.moduleRef.get<TeamService>(TeamServiceClass, {
              strict: false,
            });
            await teamService?.remove(workspaceId, linkedTeamMemberId, requestUserId);
          } catch (err) {
            this.logger.warn(
              `removeMember offboarding cascade failed (non-fatal) ws=${workspaceId} ` +
                `teamMember=${linkedTeamMemberId}: ${(err as Error)?.message ?? err}`,
            );
            Sentry.captureException(err, {
              tags: { module: 'workspaces', op: 'removeMember.offboardCascade' },
              extra: { workspaceId, memberId, linkedTeamMemberId },
            });
          }
        }

        this.auditWorkspaceEvent({
          action: 'workspace.member_removed',
          workspaceId,
          actorId: requestUserId,
          entityType: 'workspace_member',
          entityId: memberId,
          meta: {
            removedUserId: member.userId?.toString() ?? null,
            offboardCascade: !!linkedTeamMemberId,
          },
        });

        this.postHog.capture({
          distinctId: requestUserId,
          event: 'workspace.member_removed',
          properties: { workspaceId, memberId, offboardCascade: !!linkedTeamMemberId },
        });
      },
    );
  }

  async changeMemberRole(
    workspaceId: string,
    memberId: string,
    actorId: string,
    changeDto: ChangeMemberRoleDto,
  ) {
    return this.withWorkspaceSpan(
      'workspace.changeMemberRole',
      { workspaceId, memberId, actorId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        // Defense in depth — workspace scope explicit; the controller's
        // RolesGuard already enforces actor authorization (G2 fix, Wave 2).
        const member = await this.memberModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(memberId),
              workspaceId: new Types.ObjectId(workspaceId),
            },
            {
              roleId: changeDto.roleId ? new Types.ObjectId(changeDto.roleId) : null,
            },
            { new: true },
          )
          .exec();
        if (!member) throw new NotFoundException('Member not found');

        // Wave 2 W2.2 — push to revocation denylist so the member's existing
        // sessions re-resolve their (now-changed) role on the next request.
        if (member.userId) {
          await this.revocationService.revoke(workspaceId, String(member.userId));
        }

        this.auditWorkspaceEvent({
          action: 'workspace.member_role_changed',
          workspaceId: member.workspaceId,
          actorId,
          entityType: 'workspace_member',
          entityId: memberId,
          meta: { roleId: changeDto.roleId ?? null },
        });

        this.postHog.capture({
          distinctId: String(member.userId ?? memberId),
          event: 'workspace.member_role_changed',
          properties: {
            workspaceId: String(member.workspaceId),
            memberId,
            roleId: changeDto.roleId ?? null,
          },
        });

        return member;
      },
    );
  }

  /**
   * Wave 2 W2.6 — list invites for the calling user across all workspaces.
   * Drives the workspace-switcher pending-invite badge. Excludes invites
   * that have a `userId` mismatch (those were sent to a different account
   * with the same email/mobile — defensive filter).
   */
  /**
   * P2.0.1 (2026-05-15) — resolve every WorkspaceMember filter shape that
   * "belongs to this caller". Cold-path invites carry `userId: null` until
   * accepted; warm-path lookups may bind to a stale User if multiple
   * accounts share an identifier. Matching on `userId OR
   * inviteeIdentifier ∈ {caller.mobile, caller.email}` makes pending /
   * history / accept / decline robust to both cases — the same
   * cross-workspace identifier-binding semantics Wave 2 ships for
   * `/me/invites/pending`.
   */
  private async buildCallerInviteFilter(userId: string): Promise<{
    oid: Types.ObjectId;
    identifierVals: string[];
    filter: Record<string, unknown>;
  }> {
    const oid = new Types.ObjectId(userId);
    const userModel = this.memberModel.db.model('User');
    const user = await userModel.findById(oid, { mobile: 1, email: 1 }).lean().exec();
    const identifierVals: string[] = [];
    if (user && typeof user === 'object') {
      const u = user as { mobile?: string; email?: string };
      if (u.mobile) identifierVals.push(u.mobile);
      if (u.email) identifierVals.push(u.email);
    }
    const filter: Record<string, unknown> = identifierVals.length
      ? { $or: [{ userId: oid }, { inviteeIdentifier: { $in: identifierVals } }] }
      : { userId: oid };
    return { oid, identifierVals, filter };
  }

  /**
   * P2.0 (2026-05-15) — invites sent by the caller across all workspaces.
   * Drives the Sent tab on /dashboard/invitations.
   *
   * Lifecycle: returns 'invited', 'active' (accepted), 'declined',
   * 'removed' so the FE can render the full audit + status chips. Expired
   * pendings stay status='invited' until a sweep cron transitions them;
   * the FE derives the 'expired' visual badge from inviteExpiry < now.
   */
  async findInvitesSentBy(userId: string) {
    return this.withWorkspaceSpan('workspace.findInvitesSentBy', { userId }, async () => {
      const invites = await this.memberModel
        .find({
          invitedBy: new Types.ObjectId(userId),
          status: { $in: ['invited', 'active', 'declined', 'removed'] },
        })
        .populate('workspaceId', 'name businessType branding')
        .populate('roleId', 'name isSystem')
        .populate('userId', 'name')
        .sort({ createdAt: -1 })
        .lean()
        .exec();

      return invites.map((inv: any) => ({
        id: String(inv._id),
        workspace: inv.workspaceId
          ? {
              id: String(inv.workspaceId._id),
              name: inv.workspaceId.name,
              businessType: inv.workspaceId.businessType,
              logo: inv.workspaceId.branding?.logo,
            }
          : null,
        role: inv.roleId
          ? {
              id: String(inv.roleId._id),
              name: inv.roleId.name,
              isSystem: inv.roleId.isSystem,
            }
          : null,
        invitee: inv.userId ? { id: String(inv.userId._id), name: inv.userId.name } : null,
        inviteeIdentifier: inv.inviteeIdentifier ?? null,
        inviteeType: inv.inviteeType ?? null,
        status: inv.status,
        createdAt: inv.createdAt,
        inviteExpiry: inv.inviteExpiry ?? null,
        joinedAt: inv.joinedAt ?? null,
        declinedAt: inv.declinedAt ?? null,
        removedAt: inv.removedAt ?? null,
        linkedTeamMemberId: inv.linkedTeamMemberId ? String(inv.linkedTeamMemberId) : null,
      }));
    });
  }

  /**
   * P2.0 (2026-05-15) — past invitations received by the caller (not
   * pending). Drives the History filter chip on the Received tab.
   */
  async findInviteHistoryForUser(userId: string) {
    return this.withWorkspaceSpan('workspace.findInviteHistoryForUser', { userId }, async () => {
      // P2.0.1 (2026-05-15) — identifier-or-userId match so accepted /
      // declined / removed invites surface even when bound at a time the
      // caller's User row hadn't yet been linked on the WorkspaceMember.
      const { filter } = await this.buildCallerInviteFilter(userId);
      const invites = await this.memberModel
        .find({ ...filter, status: { $in: ['active', 'declined', 'removed'] } })
        .populate('workspaceId', 'name businessType branding')
        .populate('roleId', 'name isSystem')
        .populate('invitedBy', 'name')
        .sort({ updatedAt: -1 })
        .lean()
        .exec();

      return invites.map((inv: any) => ({
        id: String(inv._id),
        workspace: inv.workspaceId
          ? {
              id: String(inv.workspaceId._id),
              name: inv.workspaceId.name,
              businessType: inv.workspaceId.businessType,
              logo: inv.workspaceId.branding?.logo,
            }
          : null,
        role: inv.roleId
          ? {
              id: String(inv.roleId._id),
              name: inv.roleId.name,
              isSystem: inv.roleId.isSystem,
            }
          : null,
        invitedBy: inv.invitedBy?.name || 'Unknown',
        status: inv.status,
        joinedAt: inv.joinedAt ?? null,
        declinedAt: inv.declinedAt ?? null,
        removedAt: inv.removedAt ?? null,
      }));
    });
  }

  async getPendingInvitesForUser(userId: string) {
    return this.withWorkspaceSpan('workspace.getPendingInvitesForUser', { userId }, async () => {
      // P2.0.1 (2026-05-15) — match by userId OR by inviteeIdentifier so
      // cold-path invites (userId still null) and warm-path invites bound
      // to a stale User both surface for the real invitee.
      const { filter } = await this.buildCallerInviteFilter(userId);
      const invites = await this.memberModel
        .find({ ...filter, status: 'invited' })
        .populate('workspaceId', 'name businessType branding')
        .populate('roleId', 'name isSystem')
        .populate('invitedBy', 'name')
        .lean()
        .exec();

      return invites.map((inv: any) => ({
        id: inv._id,
        workspace: inv.workspaceId
          ? {
              id: inv.workspaceId._id,
              name: inv.workspaceId.name,
              businessType: inv.workspaceId.businessType,
              logo: inv.workspaceId.branding?.logo,
            }
          : null,
        role: inv.roleId
          ? {
              id: inv.roleId._id,
              name: inv.roleId.name,
              isSystem: inv.roleId.isSystem,
            }
          : null,
        invitedBy: inv.invitedBy?.name || 'Unknown',
        inviteExpiry: inv.inviteExpiry,
        isLinkedToTeamMember: !!inv.linkedTeamMemberId,
      }));
    });
  }

  async getInviteDetails(token: string) {
    return this.withWorkspaceSpan('workspace.getInviteDetails', {}, async () => {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const member = await this.memberModel
        .findOne({ inviteTokenHash: tokenHash, status: 'invited' })
        .populate('workspaceId')
        .populate('invitedBy', 'name')
        .populate('roleId', 'name')
        .exec();

      if (!member) throw new BadRequestException('Invalid or expired token');

      if (member.inviteExpiry && member.inviteExpiry < new Date()) {
        throw new BadRequestException('Token expired');
      }

      const workspace: any = member.workspaceId;

      // Wave 4.8 (2026-05-10) — `requiresSignup` drives the invite landing
      // page UX: when no User exists for the invitee identifier, render the
      // atomic signup-and-accept form; otherwise route to /auth then onto
      // the W4.7 switcher accept path.
      //
      // P1.8-revert.14 (2026-05-14) — widen the lookup. When the invite is
      // linked to a TeamMember directory record, ALSO check the member's
      // mobile + email columns against the User collection. The bridge
      // row stores ONE identifier (whichever the FE prioritised at grant
      // time), so a warm user who signed up with mobile X but whose
      // invite was created against email Y would otherwise be flagged
      // as cold and shown the signup form on the landing page.
      let requiresSignup = true;
      const identifierClauses: Array<Record<string, unknown>> = [];
      if (member.inviteeIdentifier) {
        identifierClauses.push(
          member.inviteeType === 'email'
            ? { email: member.inviteeIdentifier }
            : { mobile: member.inviteeIdentifier },
        );
      }
      if (member.linkedTeamMemberId) {
        const teamMemberModel = this.memberModel.db.model('TeamMember');
        const linkedTeamMember = await teamMemberModel
          .findById(member.linkedTeamMemberId)
          .select('mobile email')
          .lean()
          .exec();
        if (linkedTeamMember) {
          const lm = linkedTeamMember as { mobile?: string; email?: string };
          if (lm.mobile) identifierClauses.push({ mobile: lm.mobile });
          if (lm.email) identifierClauses.push({ email: lm.email });
        }
      }
      if (identifierClauses.length) {
        const userModel = this.memberModel.db.model('User');
        const existing = await userModel.findOne({ $or: identifierClauses }).lean().exec();
        requiresSignup = !existing;
      }

      return {
        token,
        workspaceName: workspace.name,
        workspaceType: workspace.businessType,
        memberCount: await this.memberModel.countDocuments({
          workspaceId: workspace._id,
        }),
        invitedBy: (member.invitedBy as any)?.name || 'Unknown',
        role: (member.roleId as any)?.name || 'Member',
        identifier: member.inviteeIdentifier,
        identifierType: member.inviteeType,
        isLinkedToTeamMember: !!member.linkedTeamMemberId,
        requiresSignup,
        inviteId: String(member._id),
      };
    });
  }

  async joinWithToken(token: string, userId: string) {
    return this.withWorkspaceSpan('workspace.joinWithToken', { userId }, async () => {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const member = await this.memberModel
        .findOne({ inviteTokenHash: tokenHash, status: 'invited' })
        .exec();
      if (!member) throw new BadRequestException('Invalid or expired token');

      if (member.inviteExpiry && member.inviteExpiry < new Date()) {
        throw new BadRequestException('Token expired');
      }

      // Soft-deleted workspace — refuse to activate a membership into a hidden
      // workspace from a still-live invite link. Fetched once here and reused
      // for the notification below. Block BEFORE any member mutation / save.
      const workspace = await this.workspaceModel.findById(member.workspaceId).exec();
      if (!workspace || (workspace as unknown as { isDeleted?: boolean }).isDeleted === true) {
        throw new NotFoundException('Workspace not found');
      }

      // Link user if not already linked (post-signup auto-link case)
      if (!member.userId) {
        member.userId = new Types.ObjectId(userId);
      }
      member.status = 'active';
      member.inviteTokenHash = undefined;
      member.inviteExpiry = undefined;
      member.inviteToken = undefined;
      member.inviteeIdentifier = undefined;
      member.inviteeType = undefined;
      member.joinedAt = new Date();
      await member.save();

      // ── Wave 2 invite consolidation (2026-05-10) ───────────────────────
      // When the invite is linked to a TeamMember directory record, flip
      // hasAppAccess + linkedUserId atomically with the membership accept.
      // This replaces the team.acceptInvite path for new-flow tokens; old
      // tokens still flow through team.acceptInvite for one release.
      if (member.linkedTeamMemberId) {
        const teamMemberModel = this.memberModel.db.model('TeamMember');
        await teamMemberModel
          .updateOne(
            { _id: member.linkedTeamMemberId },
            {
              $set: {
                hasAppAccess: true,
                linkedUserId: member.userId,
                linkedWorkspaceMemberId: member._id,
                appAccessGrantedAt: new Date(),
              },
              $unset: {
                appAccessInviteToken: 1,
                appAccessInviteTokenHash: 1,
                appAccessInviteExpiry: 1,
              },
            },
          )
          .exec();
      }

      // Wave 2 W2.2 — clear any prior denylist entry (lifecycle L8: owner
      // re-grants access to a previously removed member).
      await this.revocationService.clear(String(member.workspaceId), String(member.userId));

      this.auditWorkspaceEvent({
        action: 'workspace.workspace_joined',
        workspaceId: member.workspaceId,
        actorId: userId,
        entityType: 'workspace_member',
        entityId: member._id,
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'workspace.invite_accepted',
        properties: {
          workspaceId: String(member.workspaceId),
          linkedTeamMember: !!member.linkedTeamMemberId,
        },
      });

      // P2.6 (2026-05-15) — grantor notification on accept (public token
      // path). Mirrors acceptInviteForUser; resolves the accepter from the
      // just-bound member.userId. Fire-and-forget.
      if (member.invitedBy) {
        try {
          const userModel = this.memberModel.db.model('User');
          const accepter = await userModel
            .findById(member.userId, { name: 1, mobile: 1, email: 1 })
            .lean()
            .exec();
          const a = accepter as { name?: string; mobile?: string; email?: string } | null;
          const accepterLabel = a?.name || a?.mobile || a?.email || 'A user';
          const workspaceName = (workspace as { name?: string } | null)?.name ?? 'your workspace';
          await this.notificationsService.createNotification(String(member.workspaceId), {
            recipientId: String(member.invitedBy),
            type: 'info',
            title: 'Invitation accepted',
            message: `${accepterLabel} accepted your invitation to ${workspaceName}.`,
            metadata: {
              category: 'INVITE_ACCEPTED',
              workspaceId: String(member.workspaceId),
              workspaceMemberId: String(member._id),
            },
          });
        } catch (e) {
          this.logger.error(
            `accept (token) notification fan-out failed: ${(e as Error)?.message ?? e}`,
          );
        }
      }

      return { workspace, member };
    });
  }

  /**
   * Wave 4 W4.7 (2026-05-10) — accept-from-switcher flow.
   *
   * Authenticated path keyed on the membership row's `_id` rather than the
   * raw token. The invite row's `userId` MUST match the calling user (or be
   * null + identifier-match) — this prevents anyone with a guessed inviteId
   * from accepting on someone else's behalf.
   *
   * Mirrors `joinWithToken` for the post-accept side-effects: TeamMember
   * link flip + revocation denylist clear + audit + posthog.
   */
  async acceptInviteForUser(inviteId: string, userId: string) {
    return this.withWorkspaceSpan(
      'workspace.acceptInviteForUser',
      { inviteId, userId },
      async () => {
        const member = await this.memberModel
          .findOne({
            _id: new Types.ObjectId(inviteId),
            status: 'invited',
          })
          .exec();
        if (!member) throw new NotFoundException('Invite not found');

        if (member.inviteExpiry && member.inviteExpiry < new Date()) {
          throw new BadRequestException('Invite expired');
        }

        // P2.0.1 (2026-05-15) — caller owns the invite if userId matches,
        // OR the invite's pre-bound identifier matches one of the caller's
        // (mobile / email). This unblocks two prior trap cases:
        //   1. warm-path grant bound userId to a stale/different User
        //      record sharing the same identifier (the actual invitee
        //      could never accept).
        //   2. caller signed up AFTER grant — their User row may have a
        //      different ObjectId than whatever the grant-time lookup
        //      cached on the row.
        const { oid, identifierVals } = await this.buildCallerInviteFilter(userId);
        const userIdMatch = member.userId && member.userId.toString() === userId;
        const identifierMatch =
          !!member.inviteeIdentifier && identifierVals.includes(member.inviteeIdentifier);
        if (!userIdMatch && !identifierMatch) {
          throw new ForbiddenException('Invite does not belong to you');
        }

        // Soft-deleted workspace — refuse to activate a membership into a
        // hidden workspace. Fetched once here and reused for the notification
        // below; blocks BEFORE any member mutation / save.
        const workspace = await this.workspaceModel.findById(member.workspaceId).exec();
        if (!workspace || (workspace as unknown as { isDeleted?: boolean }).isDeleted === true) {
          throw new NotFoundException('Workspace not found');
        }

        // Always re-bind userId to the caller's ObjectId — fixes any stale
        // grant-time linkage in place so downstream queries (notifications,
        // /me/invites/pending) converge on the right User from here on.
        member.userId = oid;
        member.status = 'active';
        member.inviteTokenHash = undefined;
        member.inviteExpiry = undefined;
        member.inviteToken = undefined;
        member.inviteeIdentifier = undefined;
        member.inviteeType = undefined;
        member.joinedAt = new Date();
        await member.save();

        if (member.linkedTeamMemberId) {
          const teamMemberModel = this.memberModel.db.model('TeamMember');
          await teamMemberModel
            .updateOne(
              { _id: member.linkedTeamMemberId },
              {
                $set: {
                  hasAppAccess: true,
                  linkedUserId: member.userId,
                  linkedWorkspaceMemberId: member._id,
                  appAccessGrantedAt: new Date(),
                },
                $unset: {
                  appAccessInviteToken: 1,
                  appAccessInviteTokenHash: 1,
                  appAccessInviteExpiry: 1,
                },
              },
            )
            .exec();
        }

        await this.revocationService.clear(String(member.workspaceId), String(member.userId));

        this.auditWorkspaceEvent({
          action: 'workspace.workspace_joined',
          workspaceId: member.workspaceId,
          actorId: userId,
          entityType: 'workspace_member',
          entityId: member._id,
          meta: { acceptVia: 'switcher' },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'workspace.invite_accepted',
          properties: {
            workspaceId: String(member.workspaceId),
            linkedTeamMember: !!member.linkedTeamMemberId,
            acceptVia: 'switcher',
          },
        });

        // P2.6 (2026-05-15) — grantor notification on accept. Owner sees
        // "X accepted your invitation to {workspace}" in their bell within
        // one poll tick. Fire-and-forget; notification failure must not
        // roll back the accept.
        if (member.invitedBy) {
          try {
            const userModel = this.memberModel.db.model('User');
            const accepter = await userModel
              .findById(oid, { name: 1, mobile: 1, email: 1 })
              .lean()
              .exec();
            const a = accepter as { name?: string; mobile?: string; email?: string } | null;
            const accepterLabel = a?.name || a?.mobile || a?.email || 'A user';
            const workspaceName = (workspace as { name?: string } | null)?.name ?? 'your workspace';
            await this.notificationsService.createNotification(String(member.workspaceId), {
              recipientId: String(member.invitedBy),
              type: 'info',
              title: 'Invitation accepted',
              message: `${accepterLabel} accepted your invitation to ${workspaceName}.`,
              metadata: {
                category: 'INVITE_ACCEPTED',
                workspaceId: String(member.workspaceId),
                workspaceMemberId: String(member._id),
              },
            });
          } catch (e) {
            this.logger.error(`accept notification fan-out failed: ${(e as Error)?.message ?? e}`);
          }
        }

        return { workspace, member };
      },
    );
  }

  /**
   * Wave 4 W4.7 — decline counterpart. Same identity check; flips status to
   * 'declined' rather than removing the row (audit trail per locked
   * decision #7). Owner sees declined state in member list.
   */
  async declineInviteForUser(inviteId: string, userId: string) {
    return this.withWorkspaceSpan(
      'workspace.declineInviteForUser',
      { inviteId, userId },
      async () => {
        const member = await this.memberModel
          .findOne({
            _id: new Types.ObjectId(inviteId),
            status: 'invited',
          })
          .exec();
        if (!member) throw new NotFoundException('Invite not found');

        // P2.0.1 (2026-05-15) — mirror acceptInviteForUser ownership check.
        const { identifierVals } = await this.buildCallerInviteFilter(userId);
        const userIdMatch = member.userId && member.userId.toString() === userId;
        const identifierMatch =
          !!member.inviteeIdentifier && identifierVals.includes(member.inviteeIdentifier);
        if (!userIdMatch && !identifierMatch) {
          throw new ForbiddenException('Invite does not belong to you');
        }

        member.status = 'declined';
        member.inviteToken = undefined;
        member.inviteTokenHash = undefined;
        member.inviteExpiry = undefined;
        member.declinedAt = new Date();
        await member.save();

        // P2.0.3 (2026-05-15) — clear the TeamMember bridge's invite-token
        // fields. Without this `team.service.toResponse` keeps computing
        // appAccessStatus='invited' for the declined row, so the owner's
        // App Access rail still shows pending + Resend/Cancel buttons even
        // after the invitee declined. Mirrors the unset pattern in
        // acceptInviteForUser's TeamMember update.
        if (member.linkedTeamMemberId) {
          const teamMemberModel = this.memberModel.db.model('TeamMember');
          await teamMemberModel
            .updateOne(
              { _id: member.linkedTeamMemberId },
              {
                $unset: {
                  appAccessInviteToken: 1,
                  appAccessInviteTokenHash: 1,
                  appAccessInviteExpiry: 1,
                },
              },
            )
            .exec();
        }

        // P2.0.3 (2026-05-15) — notify the grantor. Without this the owner
        // has no signal the invite was declined until they happen to look at
        // /dashboard/invitations?tab=sent. Fire-and-forget so a notification
        // failure doesn't roll back the decline.
        if (member.invitedBy) {
          try {
            const userModel = this.memberModel.db.model('User');
            const [declinerUser, workspaceDoc] = await Promise.all([
              userModel
                .findById(new Types.ObjectId(userId), { name: 1, mobile: 1, email: 1 })
                .lean()
                .exec(),
              this.workspaceModel.findById(member.workspaceId).lean().exec(),
            ]);
            const decliner = declinerUser as {
              name?: string;
              mobile?: string;
              email?: string;
            } | null;
            const declinerLabel = decliner?.name || decliner?.mobile || decliner?.email || 'A user';
            const workspaceName =
              (workspaceDoc as { name?: string } | null)?.name ?? 'your workspace';
            await this.notificationsService.createNotification(String(member.workspaceId), {
              recipientId: String(member.invitedBy),
              type: 'warning',
              title: 'Invitation declined',
              message: `${declinerLabel} declined your invitation to ${workspaceName}.`,
              metadata: {
                category: 'INVITE_DECLINED',
                workspaceId: String(member.workspaceId),
                workspaceMemberId: String(member._id),
              },
            });
          } catch (e) {
            this.logger.error(`decline notification fan-out failed: ${(e as Error)?.message ?? e}`);
          }
        }

        this.auditWorkspaceEvent({
          action: 'workspace.invite_declined',
          workspaceId: member.workspaceId,
          actorId: userId,
          entityType: 'workspace_member',
          entityId: member._id,
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'workspace.invite_declined',
          properties: { workspaceId: String(member.workspaceId) },
        });

        return { ok: true };
      },
    );
  }

  async getPendingInvitations(workspaceId: string) {
    return this.withWorkspaceSpan('workspace.getPendingInvitations', { workspaceId }, async () => {
      const members = await this.memberModel
        .find({ workspaceId: new Types.ObjectId(workspaceId), status: 'invited' })
        .populate('invitedBy', 'name')
        .populate('roleId', 'name')
        .exec();

      return members.map((m: any) => ({
        _id: m._id,
        inviteeIdentifier: m.inviteeIdentifier,
        inviteeType: m.inviteeType,
        role: m.roleId?.name || 'Member',
        invitedBy: m.invitedBy?.name || 'Unknown',
        createdAt: m.createdAt,
        inviteExpiry: m.inviteExpiry,
      }));
    });
  }

  async resendInvite(workspaceId: string, memberId: string, inviterId: string) {
    return this.withWorkspaceSpan(
      'workspace.resendInvite',
      { workspaceId, userId: inviterId },
      async () => {
        const member = await this.memberModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
            status: 'invited',
          })
          .exec();
        if (!member) {
          throw new NotFoundException('Pending invitation not found');
        }

        // Soft-deleted workspace — refuse to re-issue an invite link to a
        // hidden workspace. Fetched up front and reused below; blocks BEFORE
        // token rotation / save / dispatch.
        const workspace = await this.workspaceModel.findById(workspaceId).exec();
        if (!workspace || (workspace as unknown as { isDeleted?: boolean }).isDeleted === true) {
          throw new NotFoundException('Workspace not found');
        }

        // Generate new token
        const rawToken = crypto.randomBytes(32).toString('hex');
        member.inviteTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        member.inviteExpiry = new Date();
        member.inviteExpiry.setDate(member.inviteExpiry.getDate() + 7);
        await member.save();

        const inviter = await this.usersService.findById(inviterId);

        const inviteUrl = `${this.webAppUrl}/invite?token=${rawToken}&type=workspace`;
        const mobileDeepLink = `${this.mobileDeepLink}/${rawToken}`;
        const roleName = 'Member';

        await this.inviteDispatcher.dispatch({
          workspaceId,
          workspaceName: workspace?.name || 'a workspace',
          inviterName: inviter?.name || 'Someone',
          inviteeIdentifier: member.inviteeIdentifier || '',
          inviteeType: (member.inviteeType as 'email' | 'mobile') || 'email',
          inviteeUserId: member.userId?.toString(),
          role: roleName,
          inviteUrl,
          mobileDeepLink,
        });

        this.auditWorkspaceEvent({
          action: 'workspace.invite_resent',
          workspaceId,
          actorId: inviterId,
          entityType: 'workspace_member',
          entityId: memberId,
          meta: {
            inviteeType: member.inviteeType,
            inviteeIdentifier: member.inviteeIdentifier,
          },
        });

        return { message: 'Invitation resent' };
      },
    );
  }

  async cancelInvite(workspaceId: string, memberId: string) {
    return this.withWorkspaceSpan('workspace.cancelInvite', { workspaceId }, async () => {
      await this.assertWorkspaceNotDeleted(workspaceId);
      const member = await this.memberModel
        .findOne({
          _id: new Types.ObjectId(memberId),
          workspaceId: new Types.ObjectId(workspaceId),
          status: 'invited',
        })
        .exec();
      if (!member) {
        throw new NotFoundException('Pending invitation not found');
      }

      member.status = 'declined';
      member.inviteTokenHash = undefined;
      member.inviteExpiry = undefined;
      member.inviteeIdentifier = undefined;
      member.inviteeType = undefined;
      await member.save();

      this.auditWorkspaceEvent({
        action: 'workspace.invite_cancelled',
        workspaceId,
        actorId: member.invitedBy ?? memberId,
        entityType: 'workspace_member',
        entityId: memberId,
      });

      return { message: 'Invitation cancelled' };
    });
  }

  async declineInvite(token: string) {
    return this.withWorkspaceSpan('workspace.declineInvite', {}, async () => {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const member = await this.memberModel
        .findOne({ inviteTokenHash: tokenHash, status: 'invited' })
        .exec();
      if (!member) {
        throw new BadRequestException('Invalid or expired invitation');
      }

      member.status = 'declined';
      member.inviteTokenHash = undefined;
      member.inviteExpiry = undefined;
      member.inviteeIdentifier = undefined;
      member.inviteeType = undefined;
      member.declinedAt = new Date();
      await member.save();

      // P2.0.3 (2026-05-15) — mirror declineInviteForUser bridge cleanup +
      // grantor notification on the public token route. Without this an
      // unauthenticated decline (cold invitee using the landing page)
      // leaves the owner's App Access rail stuck on "Invited" + the owner
      // gets no signal the link was rejected.
      if (member.linkedTeamMemberId) {
        const teamMemberModel = this.memberModel.db.model('TeamMember');
        await teamMemberModel
          .updateOne(
            { _id: member.linkedTeamMemberId },
            {
              $unset: {
                appAccessInviteToken: 1,
                appAccessInviteTokenHash: 1,
                appAccessInviteExpiry: 1,
              },
            },
          )
          .exec();
      }

      if (member.invitedBy) {
        try {
          const workspaceDoc = await this.workspaceModel.findById(member.workspaceId).lean().exec();
          const workspaceName =
            (workspaceDoc as { name?: string } | null)?.name ?? 'your workspace';
          await this.notificationsService.createNotification(String(member.workspaceId), {
            recipientId: String(member.invitedBy),
            type: 'warning',
            title: 'Invitation declined',
            message: `An invitee declined your invitation to ${workspaceName}.`,
            metadata: {
              category: 'INVITE_DECLINED',
              workspaceId: String(member.workspaceId),
              workspaceMemberId: String(member._id),
            },
          });
        } catch (e) {
          this.logger.error(
            `public-decline notification fan-out failed: ${(e as Error)?.message ?? e}`,
          );
        }
      }

      this.auditWorkspaceEvent({
        action: 'workspace.invite_declined',
        workspaceId: member.workspaceId,
        actorId: member.invitedBy ?? member._id,
        entityType: 'workspace_member',
        entityId: member._id,
      });

      // Anonymous distinct-id (no JWT on declineInvite). Use the workspaceMember
      // _id so the event still attributes to a specific invite even though it's
      // not bound to a real user funnel.
      this.postHog.capture({
        distinctId: String(member._id),
        event: 'workspace.invite_declined',
        properties: { workspaceId: String(member.workspaceId) },
      });

      return { message: 'Invitation declined' };
    });
  }

  async getBranding(workspaceId: string) {
    return this.withWorkspaceSpan('workspace.getBranding', { workspaceId }, async () => {
      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .select('branding exportPreferences')
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');
      return {
        branding: workspace.branding,
        exportPreferences: workspace.exportPreferences,
      };
    });
  }

  async updateBranding(workspaceId: string, dto: BrandingDto) {
    return this.withWorkspaceSpan('workspace.updateBranding', { workspaceId }, async () => {
      await this.assertWorkspaceNotDeleted(workspaceId);
      // OQ-W7 (branding merge fix) — previously `$set: { branding: dto }` replaced
      // the ENTIRE branding subdocument, so a partial update (e.g. just `logo`)
      // wiped every other branding field (pdfHeaderLogo / idCardBackground / ...).
      // Build a per-field dot-notation $set so only the fields the caller actually
      // sent are written and the rest are preserved. An explicit `null`/empty
      // string from the caller still clears that one field (intentional reset).
      const $set: Record<string, unknown> = {};
      for (const key of Object.keys(dto) as Array<keyof BrandingDto>) {
        if (dto[key] !== undefined) {
          $set[`branding.${key}`] = dto[key];
        }
      }
      const workspace = await this.workspaceModel
        .findByIdAndUpdate(new Types.ObjectId(workspaceId), { $set }, { new: true })
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      this.auditWorkspaceEvent({
        action: 'workspace.branding_updated',
        workspaceId,
        actorId: workspace.ownerId,
        meta: { fieldsChanged: Object.keys(dto) },
      });

      this.postHog.capture({
        distinctId: String(workspace.ownerId),
        event: 'workspace.branding_updated',
        properties: { workspaceId, fieldsChanged: Object.keys(dto) },
      });

      return workspace.branding;
    });
  }

  async updateExportPreferences(workspaceId: string, dto: ExportPreferencesDto) {
    return this.withWorkspaceSpan(
      'workspace.updateExportPreferences',
      { workspaceId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        const workspace = await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { exportPreferences: dto } },
            { new: true },
          )
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');

        this.auditWorkspaceEvent({
          action: 'workspace.export_preferences_updated',
          workspaceId,
          actorId: workspace.ownerId,
          meta: { fieldsChanged: Object.keys(dto) },
        });

        this.postHog.capture({
          distinctId: String(workspace.ownerId),
          event: 'workspace.export_preferences_updated',
          properties: { workspaceId },
        });

        return workspace.exportPreferences;
      },
    );
  }

  // Globally-unique, immutable workspace code (the {WS} token in employee
  // codes). Derived from the name, suffixed on collision. SSOT =
  // Workspace.workspaceCode. Mirrors team.service.ensureWorkspaceCode.
  private async generateUniqueWorkspaceCode(name?: string): Promise<string> {
    const base = deriveWorkspaceCodeBase(name);
    let candidate = base;
    for (let i = 1; i < 1000; i++) {
      const clash = await this.workspaceModel
        .findOne({ workspaceCode: candidate })
        .select('_id')
        .lean()
        .exec();
      if (!clash) break;
      candidate = `${base.slice(0, 4)}${i}`;
    }
    return candidate;
  }

  async getEmployeeCodeSettings(workspaceId: string) {
    return this.withWorkspaceSpan(
      'workspace.getEmployeeCodeSettings',
      { workspaceId },
      async () => {
        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .select('employeeCodeSettings workspaceCode name')
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');
        const settings = workspace.employeeCodeSettings ?? DEFAULT_EMPLOYEE_CODE_SETTINGS;
        // Lazily assign the workspace code for legacy workspaces so the FE
        // preview can render the {WS} token before the first member is added.
        let workspaceCode = workspace.workspaceCode;
        if (!workspaceCode) {
          workspaceCode = await this.generateUniqueWorkspaceCode(workspace.name);
          await this.workspaceModel
            .updateOne({ _id: workspace._id }, { $set: { workspaceCode } })
            .exec();
        }
        const currentCounter = await this.workspaceCounterService.getCurrent(workspaceId);
        return {
          settings,
          workspaceCode,
          currentCounter,
          nextSequence: currentCounter + 1,
        };
      },
    );
  }

  async updateEmployeeCodeSettings(workspaceId: string, dto: EmployeeCodeSettingsDto) {
    return this.withWorkspaceSpan(
      'workspace.updateEmployeeCodeSettings',
      { workspaceId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');

        const current = workspace.employeeCodeSettings ?? DEFAULT_EMPLOYEE_CODE_SETTINGS;
        const next = { ...current, ...dto };

        if (dto.startingNumber !== undefined) {
          const counterValue = await this.workspaceCounterService.getCurrent(workspaceId);
          if (dto.startingNumber <= counterValue) {
            throw new BadRequestException({
              success: false,
              message: `Starting number must be greater than the highest existing code (currently ${counterValue}). Set to ${counterValue + 1} or higher.`,
              code: 'EMP_CODE_STARTING_NUMBER_TOO_LOW',
              currentMax: counterValue,
            });
          }
          await this.workspaceCounterService.setCounter(workspaceId, dto.startingNumber - 1);
        }

        const updated = await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { employeeCodeSettings: next } },
            { new: true },
          )
          .exec();
        if (!updated) throw new NotFoundException('Workspace not found');

        const currentCounter = await this.workspaceCounterService.getCurrent(workspaceId);

        this.auditWorkspaceEvent({
          action: 'workspace.employee_code_settings_updated',
          workspaceId,
          actorId: updated.ownerId,
          meta: { enabled: next.enabled, format: next.format, prefix: next.prefix },
        });

        this.postHog.capture({
          distinctId: String(updated.ownerId),
          event: 'workspace.employee_code_settings_updated',
          properties: { workspaceId, enabled: next.enabled },
        });

        return {
          settings: updated.employeeCodeSettings,
          currentCounter,
          nextSequence: currentCounter + 1,
        };
      },
    );
  }

  // ── Kiosk endpoints (M-02) ───────────────────────────────────────────────

  /**
   * Regenerate the kiosk secret token.
   * Generates a 32-byte URL-safe secret, bcrypt-hashes it, persists the hash.
   * Returns the plaintext secret ONCE — never retrievable again.
   */
  async regenerateKioskToken(workspaceId: string): Promise<{ secret: string; rotatedAt: Date }> {
    return this.withWorkspaceSpan('workspace.regenerateKioskToken', { workspaceId }, async () => {
      await this.assertWorkspaceNotDeleted(workspaceId);
      const secret = crypto.randomBytes(32).toString('base64url');
      const kioskTokenHash = await bcrypt.hash(secret, 10);
      const rotatedAt = new Date();

      const updated = await this.workspaceModel
        .findByIdAndUpdate(
          new Types.ObjectId(workspaceId),
          { $set: { kioskTokenHash, kioskTokenRotatedAt: rotatedAt } },
          { new: true },
        )
        .exec();
      if (!updated) throw new NotFoundException('Workspace not found');

      this.auditWorkspaceEvent({
        action: 'workspace.kiosk_token_rotated',
        workspaceId,
        actorId: updated.ownerId,
        meta: { rotatedAt: rotatedAt.toISOString() },
      });

      this.postHog.capture({
        distinctId: String(updated.ownerId),
        event: 'workspace.kiosk_token_rotated',
        properties: { workspaceId },
      });

      return { secret, rotatedAt };
    });
  }

  /**
   * Update kiosk enabled/disabled state and optional CIDR allowlist.
   * If enabling for the first time (no existing token hash), auto-generates a token
   * and returns it as `secret` in the response (plaintext, shown once).
   */
  async updateKioskSettings(
    workspaceId: string,
    dto: UpdateKioskSettingsDto,
  ): Promise<{ enabled: boolean; allowedIpRanges: string[]; secret?: string }> {
    return this.withWorkspaceSpan('workspace.updateKioskSettings', { workspaceId }, async () => {
      await this.assertWorkspaceNotDeleted(workspaceId);
      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .select('kioskEnabled kioskTokenHash kioskAllowedIpRanges ownerId')
        .lean()
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      const update: Record<string, unknown> = {};
      if (dto.enabled !== undefined) update.kioskEnabled = dto.enabled;
      if (dto.allowedIpRanges !== undefined) update.kioskAllowedIpRanges = dto.allowedIpRanges;

      await this.workspaceModel
        .findByIdAndUpdate(new Types.ObjectId(workspaceId), { $set: update }, { new: true })
        .exec();

      const enabled =
        dto.enabled !== undefined ? dto.enabled : ((workspace as any).kioskEnabled ?? false);
      const allowedIpRanges =
        dto.allowedIpRanges !== undefined
          ? dto.allowedIpRanges
          : ((workspace as any).kioskAllowedIpRanges ?? []);

      const ownerIdStr = (() => {
        const o = (workspace as unknown as { ownerId?: Types.ObjectId | string }).ownerId;
        return o != null ? String(o) : workspaceId;
      })();

      // Auto-generate token when enabling for the first time
      if (enabled && !(workspace as any).kioskTokenHash) {
        const { secret } = await this.regenerateKioskToken(workspaceId);
        this.auditWorkspaceEvent({
          action: 'workspace.kiosk_settings_updated',
          workspaceId,
          actorId: ownerIdStr,
          meta: { enabled, autoGeneratedToken: true },
        });
        this.postHog.capture({
          distinctId: ownerIdStr,
          event: 'workspace.kiosk_settings_updated',
          properties: { workspaceId, enabled, autoGeneratedToken: true },
        });
        return { enabled, allowedIpRanges, secret };
      }

      this.auditWorkspaceEvent({
        action: 'workspace.kiosk_settings_updated',
        workspaceId,
        actorId: ownerIdStr,
        meta: { enabled, fieldsChanged: Object.keys(update) },
      });

      this.postHog.capture({
        distinctId: ownerIdStr,
        event: 'workspace.kiosk_settings_updated',
        properties: { workspaceId, enabled },
      });

      return { enabled, allowedIpRanges };
    });
  }

  // ── Defaulter-alert config endpoint (Attendance Defaulter Notification) ──

  /**
   * Persist per-workspace defaulter-alert configuration.
   * Uses a dedicated endpoint (not the shared PATCH /workspaces/:id) so the
   * `defaulter_alerts` subscription feature gate does not leak onto general
   * settings edits — mirrors the `:id/kiosk` design.
   */
  async updateDefaulterAlertsConfig(
    workspaceId: string,
    dto: DefaulterAlertsConfigDto,
  ): Promise<Workspace> {
    return this.withWorkspaceSpan(
      'workspace.updateDefaulterAlertsConfig',
      { workspaceId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        const workspace = await this.workspaceModel
          .findByIdAndUpdate(
            new Types.ObjectId(workspaceId),
            { $set: { 'attendanceSettings.defaulterAlerts': dto } },
            { new: true },
          )
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');

        this.auditWorkspaceEvent({
          action: 'workspace.defaulter_alerts_config_updated',
          workspaceId,
          actorId: workspace.ownerId,
          meta: { enabled: dto.enabled },
        });

        this.postHog.capture({
          distinctId: String(workspace.ownerId),
          event: 'workspace.defaulter_alerts_config_updated',
          properties: { workspaceId, enabled: dto.enabled },
        });

        return workspace;
      },
    );
  }

  // ── Notification-policy config endpoint (Phase 2.2) ───────────────────────

  /**
   * Persist per-workspace notification-policy configuration.
   * Dedicated endpoint (not the shared PATCH /workspaces/:id) so the
   * permission gate is scoped — mirrors `:id/defaulter-alerts` design.
   *
   * PATCH semantics: only the fields present in the DTO are updated. Fields
   * absent from the payload are left at their current persisted value.
   */
  async updateNotificationPolicy(
    workspaceId: string,
    actorId: string,
    dto: UpdateNotificationPolicyDto,
  ): Promise<Workspace> {
    return this.withWorkspaceSpan(
      'workspace.updateNotificationPolicy',
      { workspaceId },
      async () => {
        await this.assertWorkspaceNotDeleted(workspaceId);
        // Build a sparse $set that only touches the fields present in dto.
        const $set: Record<string, unknown> = {};
        if (dto.permissionChanges !== undefined) {
          if (dto.permissionChanges.enabled !== undefined) {
            $set['notificationPolicy.permissionChanges.enabled'] = dto.permissionChanges.enabled;
          }
          if (dto.permissionChanges.channels !== undefined) {
            if (dto.permissionChanges.channels.inApp !== undefined) {
              $set['notificationPolicy.permissionChanges.channels.inApp'] =
                dto.permissionChanges.channels.inApp;
            }
            if (dto.permissionChanges.channels.email !== undefined) {
              $set['notificationPolicy.permissionChanges.channels.email'] =
                dto.permissionChanges.channels.email;
            }
            if (dto.permissionChanges.channels.sms !== undefined) {
              $set['notificationPolicy.permissionChanges.channels.sms'] =
                dto.permissionChanges.channels.sms;
            }
          }
        }

        const workspace = await this.workspaceModel
          .findByIdAndUpdate(new Types.ObjectId(workspaceId), { $set }, { new: true })
          .exec();
        if (!workspace) throw new NotFoundException('Workspace not found');

        this.auditWorkspaceEvent({
          action: 'workspace.notification_policy_updated',
          workspaceId,
          actorId,
          meta: { dto },
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'workspace.notification_policy_updated',
          properties: { workspaceId, permissionChangesEnabled: dto.permissionChanges?.enabled },
        });

        return workspace;
      },
    );
  }
}
