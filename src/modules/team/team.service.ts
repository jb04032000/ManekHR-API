/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/no-base-to-string -- Pre-existing Mongoose populate-union + lazy-ModuleRef.get<Model<any>> patterns; documented Phase 5 W5/W6 carry-forward for separate refactor approval. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { UpdateKarigarProfileDto } from './dto/update-karigar-profile.dto';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model, PopulateOptions, Types } from 'mongoose';
import { TeamMember } from './schemas/team-member.schema';
import { deriveWorkspaceCodeBase } from '../workspaces/workspace-code.util';
import { Machine } from '../machines/schemas/machine.schema';
// Location model + service let us validate dto.locationId against the workspace
// Locations master list (same source the Machines module validates against), so
// an employee's location can never point at a foreign/deleted Location.
import { Location } from '../locations/schemas/location.schema';
import { LocationsService } from '../locations/locations.service';
// Workstream G (Salary hardening): the salary-side member-removal cascade +
// history gate. Resolved lazily via moduleRef across the forwardRef cycle, so a
// `type`-only + value import is needed (the value is used as the moduleRef token).
import { SalaryLifecycleService } from '../salary/salary-lifecycle.service';
// Attendance hardening (OQ-A1): the attendance-side member-removal cascade
// (immediate kiosk-credential scrub) + history gate (muster-roll evidence).
// Resolved lazily via moduleRef across the forwardRef cycle, same as salary.
import { AttendanceLifecycleService } from '../attendance/attendance-lifecycle.service';
// Finance/Bills hardening (OQ-FB-1): the Finance/Bills-side member history gate
// — a member with ANY Bill / posted PurchaseBill / posted ExpenseVoucher /
// LedgerEntry attributed to them must stay archived (the books stay complete).
// Resolved lazily via moduleRef across the resolution boundary, same as salary
// + attendance.
import { BillsLifecycleService } from '../bills/bills-lifecycle.service';
import { SetPieceRateConfigDto } from './dto/piece-rate-config.dto';
import {
  CreateTeamMemberDto,
  UpdateTeamMemberDto,
  GrantAccessDto,
  ImportMembersDto,
  OffboardMemberDto,
} from './dto/team.dto';
import type { MobileClassification } from './dto/check-identifier.dto';
import {
  RevokeAccessDto,
  ResendInviteDto,
  ChangeAccessRoleDto,
  SetPermissionOverridesDto,
} from './dto/access.dto';
import { WorkspaceRevocationService } from '../../common/workspace-revocation/workspace-revocation.service';
import { ModuleAction } from '../../common/enums/modules.enum';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { QueryHelper } from '../../common/helpers/query.helper';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';
import { UploadsService } from '../uploads/uploads.service';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { AuditService } from '../audit/audit.service';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import { normaliseIndianMobile } from '../auth/utils/mobile-normalizer';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CallerScopeService,
  type CallerScopeContext,
} from '../../common/services/caller-scope.service';
import {
  classifyTeamFields,
  SENSITIVE_TEAM_FIELD_GROUPS,
  TEAM_FIELD_GROUP_LABEL,
  teamFieldGroupEditPath,
} from './team-field-groups';
import { filterTeamMemberRead } from './team-read-filter';
import { toTeamActivityDto } from './team-activity.mapper';
import { assertViewEditCoherent } from '../rbac/coherence';
import { assertDepsResolved } from '../rbac/dep-resolver';
import { applyPathOverrides } from '../rbac/permission-path-overrides';
import { findRegistryNode } from '../rbac/permission-registry';
import type { GrantedPermission } from '../rbac/permission-matcher';
import { diffGrants } from '../rbac/grants-diff';
import { PermissionNotificationDispatcher } from './permission-notification.dispatcher';
import { PermissionEventsService } from '../../common/realtime/permission-events.service';
import { MobileOtpService } from './mobile-otp.service';
// Phase 6 (member-cap read filter): read-time grandfathering of an over-limit
// workspace's roster. Injected to scope the ORG-scoped Team list to the allowed
// member set + surface the "showing N of TOTAL" cap status. Optional (appended
// LAST in the constructor) so positional unit-test construction keeps it
// undefined and the cap is a no-op there.
import { ErpMemberCapService } from '../subscriptions/member-cap/erp-member-cap.service';

interface EmployeeCodeSettings {
  enabled: boolean;
  format: string;
  prefix: string;
  startingNumber: number;
  allowCustom: boolean;
}

// Default employee-code settings when a workspace never configured any.
// enabled:true => auto-generation is ON by default (owner request 2026-06-13),
// so every new member (single add + CSV import) gets a sequential code unless
// the owner explicitly disables it. Keep in sync with workspaces.service
// DEFAULT_EMPLOYEE_CODE_SETTINGS.
// allowCustom retired (owner request 2026-06-13): codes are ALWAYS system-
// generated, immutable, and non-replaceable. The default format embeds {WS}
// (the workspace code) so every code names its workspace, e.g. ZARI-EMP-0001.
const DEFAULT_AUTO_CODE_SETTINGS: EmployeeCodeSettings = {
  enabled: true,
  format: '{WS}-{PREFIX}-{####}',
  prefix: 'EMP',
  startingNumber: 1,
  allowCustom: false,
};

/**
 * Render an employee code by substituting format tokens with the workspace
 * code, sequence number, and the current date. Supports {WS}, {PREFIX},
 * {YYYY}, {YY}, {MM}, and the zero-padded sequence tokens {#}, {##}, {###},
 * {####}.
 *
 * Token replacement order matters — longest first — so {####} is consumed
 * before {###}, and so on. Every code MUST name its workspace: when the
 * configured format omits {WS}, the workspace code is prepended so legacy
 * workspaces (format saved before the {WS} token existed) still comply.
 */
function renderEmployeeCode(
  format: string,
  prefix: string,
  sequence: number,
  workspaceCode = '',
  now: Date = new Date(),
): string {
  const yyyy = now.getFullYear().toString();
  const yy = yyyy.slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const hasWsToken = /\{WS\}/i.test(format);
  let code = format
    .replace(/\{WS\}/gi, workspaceCode)
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{####\}/g, String(sequence).padStart(4, '0'))
    .replace(/\{###\}/g, String(sequence).padStart(3, '0'))
    .replace(/\{##\}/g, String(sequence).padStart(2, '0'))
    .replace(/\{#\}/g, String(sequence));
  if (!hasWsToken && workspaceCode) code = `${workspaceCode}-${code}`;
  return code;
}

function isEmployeeCodeDuplicate(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  ) {
    const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern && 'employeeCode' in keyPattern) return true;
    const message = String((error as { message?: string }).message ?? '');
    return message.includes('employeeCode');
  }
  return false;
}

function isIndexDuplicate(error: unknown, field: 'mobile' | 'email'): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  ) {
    const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern && field in keyPattern) return true;
    const message = String((error as { message?: string }).message ?? '');
    return message.includes(`${field}_1`) || message.includes(`"${field}"`);
  }
  return false;
}

// ── Typed shapes for populated Mongoose plain objects ──────────────────────

interface PopulatedRole {
  _id?: Types.ObjectId;
  id?: string;
  name: string;
  color?: string;
}

interface PopulatedShift {
  _id?: Types.ObjectId;
  id?: string;
  name: string;
  startTime?: string;
  endTime?: string;
  color?: string;
}

interface TeamMemberDoc {
  _id?: Types.ObjectId;
  name: string;
  mobile?: string;
  email?: string;
  designation?: string;
  department?: string;
  location?: string;
  locationId?: Types.ObjectId;
  avatar?: string;
  rbacRoleId?: PopulatedRole | Types.ObjectId;
  hasAppAccess?: boolean;
  linkedUserId?: Types.ObjectId;
  appAccessInviteToken?: string;
  appAccessInviteTokenHash?: string;
  appAccessInviteExpiry?: Date | string;
  /** Populated `{ _id, name }` when the response chain runs
   *  `.populate(GRANTED_BY_POPULATE)`; raw ObjectId otherwise. */
  appAccessGrantedBy?: Types.ObjectId | { _id?: Types.ObjectId; name?: string };
  appAccessGrantedAt?: Date | string;
  permissionOverrides?: Array<{
    module: string;
    action: string;
    allowed: boolean;
    scope?: 'self' | 'all';
  }>;
  shiftId?: PopulatedShift | Types.ObjectId;
  weeklyOff?: string[];
  scheduleType?: string;
  customSchedule?: unknown;
  salaryType?: string;
  salaryAmount?: number;
  dailyHours?: number;
  workingDays?: number;
  finalMonthlyOverride?: number | null;
  pan?: string;
  uan?: string;
  taxRegime?: 'old' | 'new';
  stateOfEmployment?: string;
  employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern' | 'consultant';
  pfApplicable?: boolean;
  pfOptedOut?: boolean;
  esiApplicable?: boolean;
  esiIpNumber?: string;
  maritalStatus?: 'single' | 'married' | 'divorced' | 'widowed';
  bankDetails?: { passbookImageUrl?: string };
  upiDetails?: { qrCodeUrl?: string };
  preferredMethod?: string;
  aadhaar?: string;
  aadhaarImageUrl?: string;
  fatherOrSpouseName?: string;
  nationality?: string;
  employeeCode?: string;
  reportsTo?: Types.ObjectId | null;
  dateOfBirth?: Date;
  dateOfJoining?: Date;
  dateOfResignation?: Date;
  resignationNote?: string;
  gender?: string;
  bloodGroup?: string;
  emergencyContactName?: string;
  emergencyContactNumber?: string;
  address?: string;
  isActive?: boolean;
  isDeleted?: boolean;
  deletedAt?: Date;
  createdAt?: Date;
}

interface SubscriptionEntitlements {
  maxMembersPerWorkspace: number;
  maxTotalMembers: number;
}

interface SubscriptionDoc {
  _id?: any;
  status?: string;
  purchasedEntitlements?: SubscriptionEntitlements;
  appliedEntitlements?: SubscriptionEntitlements;
}

// ──────────────────────────────────────────────────────────────────────────

/**
 * Strips all non-tax fields from a team member response.
 * Used when a request originates from a CA (Chartered Accountant) role.
 * Returns only fields needed for tax/statutory compliance purposes.
 */
export function transformForCaRole(member: any): Partial<any> {
  return {
    _id: member._id,
    id: member._id,
    name: member.name,
    pan: member.pan,
    employmentType: member.employmentType,
    pfApplicable: member.pfApplicable,
    esiApplicable: member.esiApplicable,
    tdsApplicable: member.tdsApplicable,
    professionalTax: member.professionalTax,
  };
}

const ROLE_POPULATE: PopulateOptions = {
  path: 'rbacRoleId',
  select: 'name color',
};
const SHIFT_POPULATE: PopulateOptions = {
  path: 'shiftId',
  select: 'name startTime endTime color',
};
const GRANTED_BY_POPULATE: PopulateOptions = {
  path: 'appAccessGrantedBy',
  select: 'name',
};

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);
  private readonly tracer = trace.getTracer('team');
  private readonly webAppUrl: string;
  private readonly mobileDeepLink: string;
  private readonly atlasSearchEnabled: boolean;

  constructor(
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    @InjectModel(Machine.name) private readonly machineModel: Model<Machine>,
    // Location model + service for validating dto.locationId on create/update.
    // Both resolve via the LocationsModule re-exported into TeamModule.
    @InjectModel(Location.name) private readonly locationModel: Model<Location>,
    private readonly locationsService: LocationsService,
    private moduleRef: ModuleRef,
    private uploadsService: UploadsService,
    private configService: ConfigService,
    private mailService: MailService,
    private smsService: SmsService,
    private auditService: AuditService,
    private workspaceCounterService: WorkspaceCounterService,
    private postHog: PostHogService,
    private revocationService: WorkspaceRevocationService,
    private notificationsService: NotificationsService,
    private readonly callerScope: CallerScopeService,
    private readonly permissionDispatcher: PermissionNotificationDispatcher,
    private readonly mobileOtpService: MobileOtpService,
    private readonly permissionEvents: PermissionEventsService,
    // Phase 6 (member-cap read filter): appended LAST + OPTIONAL so existing
    // positional unit-test construction keeps it undefined. The findAll org-
    // scoped path null-guards it, so the cap is a behaviour-preserving no-op when
    // absent (and a transparent pass-through in prod until a workspace is over
    // cap past grace — getAllowedMemberIds returns everyone otherwise).
    private readonly memberCap?: ErpMemberCapService,
  ) {
    this.webAppUrl = this.configService.get<string>('app.webAppUrl') || 'https://app.manekhr.in';
    this.mobileDeepLink =
      this.configService.get<string>('app.mobileDeepLink') || 'zari360://invite';
    this.atlasSearchEnabled = this.configService.get<string>('ATLAS_SEARCH_ENABLED') === 'true';
  }

  /**
   * Phase 5 W6 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `WorkspacesService.withWorkspaceSpan` (W6 pilot 2026-05-09). Empty
   * `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op; the helper
   * still tags errors via `recordException` + sets ERROR status.
   */
  private async withTeamSpan<T>(
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
   * Phase 2.2 — convert a `diffGrants` result into a human-readable one-liner
   * suitable for email / SMS bodies. E.g. "added 2 paths, removed 1".
   * Returns an empty string when there are no changes (no-op grants).
   */
  private formatPathDiffSummary(diff: ReturnType<typeof diffGrants>): string {
    const parts: string[] = [];
    if (diff.added?.length)
      parts.push(`added ${diff.added.length} path${diff.added.length === 1 ? '' : 's'}`);
    if (diff.removed?.length)
      parts.push(`removed ${diff.removed.length} path${diff.removed.length === 1 ? '' : 's'}`);
    return parts.join(', ');
  }

  // ── §7 Part B — scope + separation-of-duty guards ────────────────────────
  //
  // The RolesGuard admits a request; it does not tell the service *which*
  // member rows the caller may touch. These helpers resolve the caller's
  // effective `team` scope (role + per-member overrides, via the shared
  // CallerScopeService) and enforce the `self`/`all` contract per record.
  // Nothing here is hardcoded to a role name — scope comes straight from
  // live RBAC data.

  /**
   * Assert the caller may *see* `memberId` under their effective
   * `team.directory.view` scope. `self`-scoped callers may resolve only their own
   * directory row; `all`-scoped callers and owners are unrestricted.
   * Public so the controller can gate the documents sub-resource (which
   * is served by a separate service) with the same rule.
   */
  async assertMemberReadScope(
    workspaceId: string,
    userId: string,
    memberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    this.assertReadScopeWithCtx(ctx, memberId);
  }

  /**
   * Ctx-accepting core of `assertMemberReadScope`. Callers that already
   * resolved a `CallerScopeContext` (e.g. `findById`, which also needs it for
   * read-side field-group filtering) call this directly to avoid a second
   * `callerScope.resolve` round-trip.
   */
  private assertReadScopeWithCtx(ctx: CallerScopeContext, memberId: string): void {
    const scope = this.callerScope.effectivePathScope(ctx, 'team.directory.view');
    if (ctx.isOwner) return; // explicit early-return; owners are unrestricted
    if (scope === 'all') return; // org-wide reader; unrestricted
    // Phase 1d — surface the real reason in the response. Three failure
    // modes:
    //   (a) scope === null → user has no grant at all (route guard should
    //       have already denied; reaching here is a guard/service drift).
    //   (b) scope === 'self' + ctx.teamMemberId is null → caller is a
    //       workspace member but has no TeamMember directory row (rare:
    //       removed-then-rebound, or pre-linked invite). They can't read
    //       even themselves because there's no "themselves" to point at.
    //   (c) scope === 'self' + ctx.teamMemberId !== memberId → caller is
    //       trying to read someone else's row with a self-only grant.
    if (scope === null) {
      throw new ForbiddenException(
        'You do not have permission to view team profiles in this workspace.',
      );
    }
    if (!ctx.teamMemberId) {
      throw new ForbiddenException(
        'Your account is not linked to a directory profile in this workspace. Ask the workspace owner to relink your access.',
      );
    }
    if (String(ctx.teamMemberId) !== String(memberId)) {
      throw new ForbiddenException(
        `Your role only permits viewing your own team profile (id ${ctx.teamMemberId}, not ${memberId}).`,
      );
    }
  }

  /**
   * Guard a profile write. Two layers (scope is enforced per field-group in
   * layer 2 — the route `@Patch(':memberId')` carries
   * `@RequirePermission('team.profile.personal.edit', 'all')`, so a non-`all`
   * caller never reaches this method):
   *  1. Separation-of-duty (Phase 1d) — declarative per-leaf SoD. Any
   *     registry node carrying `sodOwnerOnlyOnSelf: true` (currently
   *     `team.profile.{pay,bank,statutory,org}`) CANNOT be edited by a
   *     non-owner on their OWN record, regardless of their nominal `@all`
   *     grant. Industry universal: HR / Manager must not raise their own pay
   *     or change their own statutory IDs. Owner bypass at the top.
   *  2. Field-group authorization — every `team.profile.*` group present in
   *     the payload must be separately granted (`assertTeamFieldGroupGrants`);
   *     `team.profile.personal.edit` alone cannot reach another member's
   *     bank / pay / statutory data through this omnibus endpoint.
   *     `requiredScope` is `'self'` for own-record edits, `'all'` otherwise.
   * Owners are unaffected (bypass at the top of this method).
   */
  private async assertProfileUpdateAllowed(
    workspaceId: string,
    userId: string,
    memberId: string,
    updateDto: UpdateTeamMemberDto,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (ctx.isOwner) return;

    const isOwnRecord = !!ctx.teamMemberId && String(ctx.teamMemberId) === String(memberId);

    // Layer 1 (Phase 1d) — per-leaf SoD on own record. Industry universal:
    // HR / Manager / any non-owner cannot edit their OWN pay / bank /
    // statutory / org details even when their grant nominally scopes to
    // `all`. Declarative — applies to every leaf carrying
    // `sodOwnerOnlyOnSelf: true` in the registry.
    if (isOwnRecord) {
      const { groups } = classifyTeamFields(Object.keys(updateDto));
      for (const group of groups) {
        const leaf = findRegistryNode(`team.profile.${group}`);
        if (leaf?.sodOwnerOnlyOnSelf) {
          throw new ForbiddenException(
            `Your ${group} details are managed by the workspace owner (segregation of duties).`,
          );
        }
      }
    }

    // Layer 2 — field-group authorization. `self` when editing one's own
    // record (a `.edit@self` grant suffices); `all` when editing someone
    // else. The route guard only verifies `team.profile.personal.edit`, so
    // every other group present in the payload is re-checked here.
    this.assertTeamFieldGroupGrants(ctx, updateDto, { isOwnRecord, sensitiveOnly: false });
  }

  /**
   * Hard separation-of-duty rule: no non-owner may change their OWN role
   * assignment or permission overrides (self-escalation). Independent of
   * `selfProfileEdit` — role/permission self-assignment is always
   * owner-only, even for a role flagged `selfProfileEdit: 'allow'`.
   */
  private async assertNotSelfPrivilegeEdit(
    workspaceId: string,
    userId: string,
    memberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (ctx.isOwner) return;
    if (ctx.teamMemberId && String(ctx.teamMemberId) === String(memberId)) {
      throw new ForbiddenException(
        'You cannot change your own role or permissions — ask the workspace owner.',
      );
    }
  }

  /**
   * RBAC re-architecture §6/§7 — field-group authorization for the omnibus
   * team write endpoints. The route guard checks a single permission path;
   * this splits the wide DTO by registry field-group and requires the caller
   * to hold each present group's `.edit` grant. Owners bypass.
   *
   *  - `sensitiveOnly` — on member CREATE the non-sensitive groups (personal,
   *    job) are covered by the coarse `team.member.create` grant, so only the
   *    sensitive groups (pay / bank / statutory / org) are gated. On UPDATE
   *    every group present is gated individually.
   *  - `isOwnRecord` — a member editing their OWN record needs only a
   *    `self`-scoped grant; editing someone else needs `all`.
   *
   * Fail-closed: a DTO key not classified in `team-field-groups` is rejected
   * as owner-only (a new field stays un-writable by non-owners until mapped).
   */
  private assertTeamFieldGroupGrants(
    ctx: CallerScopeContext,
    dto: object,
    opts: { isOwnRecord: boolean; sensitiveOnly: boolean },
  ): void {
    if (ctx.isOwner) return;

    const { groups, unknownKeys } = classifyTeamFields(Object.keys(dto));
    if (unknownKeys.length > 0) {
      throw new ForbiddenException(
        `These fields can only be changed by the workspace owner: ${unknownKeys.join(', ')}.`,
      );
    }

    const requiredScope: 'self' | 'all' = opts.isOwnRecord ? 'self' : 'all';
    for (const group of groups) {
      if (opts.sensitiveOnly && !SENSITIVE_TEAM_FIELD_GROUPS.has(group)) continue;
      if (!this.callerScope.hasPath(ctx, teamFieldGroupEditPath(group), requiredScope)) {
        throw new ForbiddenException(
          `You do not have permission to change this member's ${TEAM_FIELD_GROUP_LABEL[group]}.`,
        );
      }
    }
  }

  /**
   * Phase 5 W5 — fire-and-forget audit-event helper. Mirrors workspace's
   * `auditWorkspaceEvent` (W5 pilot 2026-05-09). Failure here must NEVER
   * break the caller's primary operation; we swallow + Sentry-tag for
   * follow-up.
   */
  auditTeamEvent(input: {
    action: string;
    workspaceId: string | Types.ObjectId;
    actorId: string | Types.ObjectId;
    memberId?: string | Types.ObjectId;
    actorNameSnapshot?: string;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = String(input.workspaceId);
    const actor = String(input.actorId);
    const member = input.memberId != null ? String(input.memberId) : undefined;
    void (async () => {
      // 2026-05-23: resolve the ACTOR's display name. A member-actor (manager
      // with app access) carries their name on the TeamMember doc; their linked
      // User can be nameless for mobile-invite accounts. Prefer TeamMember.name;
      // otherwise AuditService.logEvent resolves User.name from actorId.
      // input.actorNameSnapshot is intentionally ignored — call sites
      // historically passed the TARGET member name, which was the wrong "who".
      const actorNameSnapshot = await this.resolveTeamActorName(wsId, actor);
      await this.auditService.logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.TEAM,
        entityType: 'team_member',
        entityId: member ?? wsId,
        teamMemberId: member,
        action: input.action,
        actorId: actor,
        actorNameSnapshot,
        meta: input.meta,
      });
    })().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Audit log failed for team event ${input.action} (workspace ${wsId}): ${detail}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'team', op: `audit.${input.action}` },
        extra: { workspaceId: wsId, actorId: actor },
      });
    });
  }

  /**
   * Resolve the display name of an ACTOR for team audit events. Member-actors
   * carry their name on the TeamMember doc (their linked User may be nameless
   * for mobile-invite accounts), so prefer that; return undefined so
   * AuditService.logEvent falls back to User.name (owner / admin).
   */
  private async resolveTeamActorName(
    workspaceId: string,
    actorId: string,
  ): Promise<string | undefined> {
    try {
      const tm = await this.teamModel
        .findOne({
          workspaceId: new Types.ObjectId(workspaceId),
          linkedUserId: new Types.ObjectId(actorId),
          isDeleted: false,
        })
        .select('name')
        .lean<{ name?: string } | null>()
        .exec();
      return tm?.name?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Member-scoped activity feed — every audited team event for one member,
   * newest first. Gated to `team.appAccess.manage` at the controller. Each
   * event is redacted via the team activity mapper (no sensitive values leak).
   */
  async listMemberActivity(workspaceId: string, memberId: string, limit = 50) {
    const { items, total } = await this.auditService.listWorkspaceEvents(workspaceId, {
      module: AppModuleEnum.TEAM,
      entityType: 'team_member',
      entityId: memberId,
      limit,
    });
    const member = await this.teamModel
      .findById(memberId)
      .select('name')
      .lean<{ name?: string } | null>()
      .exec();
    return { items: items.map((e) => toTeamActivityDto(e, member?.name)), total };
  }

  /**
   * Workspace-wide team activity feed — filterable (actor / action / date) +
   * paginated. Gated to `team.appAccess.manage` at the controller. Target
   * member names are batch-resolved; every event is redacted before return.
   */
  async listTeamActivity(
    workspaceId: string,
    filters: {
      actorId?: string;
      action?: string;
      dateFrom?: Date;
      dateTo?: Date;
      page?: number;
      limit?: number;
    },
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const page = Math.max(filters.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const { items, total } = await this.auditService.listWorkspaceEvents(workspaceId, {
      module: AppModuleEnum.TEAM,
      actorId: filters.actorId,
      action: filters.action,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      limit,
      offset,
    });

    // Batch-resolve current target-member names (the audit row has no target
    // name snapshot). Missing members fall back to "Removed member" downstream.
    const memberIds = [
      ...new Set(
        items
          .filter((e) => e.entityType === 'team_member' && e.entityId)
          .map((e) => String(e.entityId)),
      ),
    ];
    const nameById = new Map<string, string>();
    if (memberIds.length > 0) {
      const docs = await this.teamModel
        .find({ _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) } })
        .select('name')
        .lean<{ _id: Types.ObjectId; name?: string }[]>()
        .exec();
      for (const d of docs) nameById.set(String(d._id), d.name ?? 'Removed member');
    }

    return {
      items: items.map((e) =>
        toTeamActivityDto(e, e.entityId ? nameById.get(String(e.entityId)) : undefined),
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * Transform a Mongoose document to the API response shape
   */

  private toResponse(member: TeamMember | TeamMemberDoc): any {
    const obj = (
      (member as TeamMember).toObject ? (member as TeamMember).toObject() : member
    ) as TeamMemberDoc;

    // Compute app access status
    let appAccessStatus: 'none' | 'invited' | 'active' = 'none';
    if (obj.hasAppAccess && obj.linkedUserId) {
      appAccessStatus = 'active';
    } else if (
      obj.appAccessInviteToken &&
      obj.appAccessInviteExpiry &&
      new Date(obj.appAccessInviteExpiry) > new Date()
    ) {
      appAccessStatus = 'invited';
    }

    // Build rbacRole from populated rbacRoleId
    let rbacRole: { id: string | undefined; name: string; color: string } | undefined;
    const roleField = obj.rbacRoleId;
    if (roleField && typeof roleField === 'object' && 'name' in roleField) {
      const role = roleField;
      rbacRole = {
        id: role._id?.toString() ?? role.id,
        name: role.name,
        color: role.color ?? '#6B7280',
      };
    }

    // Build shift from populated shiftId
    let shift:
      | {
          id: string | undefined;
          name: string;
          startTime?: string;
          endTime?: string;
          color: string;
        }
      | undefined;
    const shiftField = obj.shiftId;
    if (shiftField && typeof shiftField === 'object' && 'name' in shiftField) {
      const s = shiftField;
      shift = {
        id: s._id?.toString() ?? s.id,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        color: s.color ?? '#6B7280',
      };
    }

    // Helper to convert Date to ISO string
    const toISOString = (date: Date | string | undefined): string | undefined => {
      if (!date) return undefined;
      if (typeof date === 'string') return date;
      return date.toISOString();
    };

    return {
      id: obj._id?.toString(),
      name: obj.name,
      mobile: obj.mobile,
      email: obj.email ?? undefined,
      designation: obj.designation ?? undefined,
      department: obj.department ?? undefined,
      location: obj.location ?? undefined,
      // Expose the master-list reference so the edit form can pre-select the
      // location radio (the denormalised `location` name above is for display).
      locationId: obj.locationId ? String(obj.locationId) : undefined,
      avatar: obj.avatar ?? undefined,
      rbacRole,
      rbacRoleId:
        roleField && typeof roleField === 'object' && '_id' in roleField
          ? (roleField as PopulatedRole)._id?.toString()
          : roleField?.toString(),
      hasAppAccess: obj.hasAppAccess ?? false,
      appAccessStatus,
      // P1.8-revert.11 (2026-05-14) — surface the raw token for INVITED
      // state so the rail can render a copyable share link any time the
      // owner returns to the detail page (not only immediately after
      // grant). Token is owner-scoped via JwtAuthGuard + team:view
      // permission + workspace tenant filter; carries no risk beyond
      // the existing invite flow.
      appAccessInviteToken: appAccessStatus === 'invited' ? obj.appAccessInviteToken : undefined,
      appAccessInviteExpiry: toISOString(obj.appAccessInviteExpiry),
      appAccessGrantedAt: toISOString(obj.appAccessGrantedAt),
      appAccessGrantedBy:
        obj.appAccessGrantedBy &&
        typeof obj.appAccessGrantedBy === 'object' &&
        '_id' in obj.appAccessGrantedBy
          ? obj.appAccessGrantedBy._id?.toString()
          : obj.appAccessGrantedBy?.toString(),
      appAccessGrantedByName:
        obj.appAccessGrantedBy &&
        typeof obj.appAccessGrantedBy === 'object' &&
        'name' in obj.appAccessGrantedBy
          ? (obj.appAccessGrantedBy as { name?: string }).name
          : undefined,
      permissionOverrides: obj.permissionOverrides ?? [],
      // Phase 1c/1d — path-model overrides. Must be returned alongside the
      // flat overrides so the FE matrix can render the persisted state.
      // Omitting this field silently strips the override on every read; the
      // DB keeps it, RolesGuard enforces it, but the FE matrix re-mounts
      // empty and the user thinks the save failed.
      permissionPathOverrides: obj.permissionPathOverrides ?? [],
      linkedUserId: obj.linkedUserId?.toString() ?? undefined,
      shift,
      weeklyOff: obj.weeklyOff ?? [],
      scheduleType: obj.scheduleType ?? 'shift',
      customSchedule: obj.customSchedule ?? undefined,
      salaryType: obj.salaryType ?? 'monthly',
      salaryAmount: obj.salaryAmount ?? 0,
      dailyHours: obj.dailyHours ?? undefined,
      workingDays: obj.workingDays ?? undefined,
      finalMonthlyOverride: obj.finalMonthlyOverride ?? undefined,
      // 2026-05-23 fix: the salary-calculation cluster was never serialized, so
      // the edit form hydrated these as undefined -> the required Day Basis
      // (and Fixed Month Days) showed "fill required field" and a save could
      // wipe the persisted values. Round-trip them now.
      salaryDayBasis: obj.salaryDayBasis ?? undefined,
      fixedMonthDays: obj.fixedMonthDays ?? undefined,
      attendancePayMode: obj.attendancePayMode ?? undefined,
      ctcAmount: obj.ctcAmount ?? undefined,
      componentTemplateId: obj.componentTemplateId?.toString() ?? undefined,
      componentOverrides: obj.componentOverrides ?? [],
      pan: obj.pan ?? undefined,
      uan: obj.uan ?? undefined,
      taxRegime: obj.taxRegime ?? 'new',
      stateOfEmployment: obj.stateOfEmployment ?? undefined,
      employmentType: obj.employmentType ?? 'full_time',
      pfApplicable: obj.pfApplicable ?? true,
      pfOptedOut: obj.pfOptedOut ?? false,
      esiApplicable: obj.esiApplicable ?? false,
      esiIpNumber: obj.esiIpNumber ?? undefined,
      maritalStatus: obj.maritalStatus ?? undefined,
      bankDetails: obj.bankDetails ?? undefined,
      upiDetails: obj.upiDetails ?? undefined,
      preferredMethod: obj.preferredMethod ?? undefined,
      aadhaar: obj.aadhaar ?? undefined,
      aadhaarImageUrl: obj.aadhaarImageUrl ?? undefined,
      fatherOrSpouseName: obj.fatherOrSpouseName ?? undefined,
      nationality: obj.nationality ?? 'Indian',
      employeeCode: obj.employeeCode ?? undefined,
      dateOfBirth: toISOString(obj.dateOfBirth),
      dateOfJoining: toISOString(obj.dateOfJoining),
      dateOfResignation: toISOString(obj.dateOfResignation),
      gender: obj.gender,
      bloodGroup: obj.bloodGroup,
      emergencyContactName: obj.emergencyContactName,
      emergencyContactNumber: obj.emergencyContactNumber,
      address: obj.address,
      reportsTo: obj.reportsTo?.toString() ?? null,
      isActive: obj.isActive !== false,
      isDeleted: obj.isDeleted === true,
      deletedAt: toISOString(obj.deletedAt),
      createdAt: toISOString(obj.createdAt),
      // Phase 1f.1 — mobile OTP verification timestamp. Null when skipped.
      mobileVerifiedAt: (obj as Record<string, unknown>).mobileVerifiedAt
        ? toISOString((obj as Record<string, unknown>).mobileVerifiedAt as Date)
        : null,
    };
  }

  /**
   * Atlas Search aggregation path — only called when ATLAS_SEARCH_ENABLED=true
   * and options.search is non-empty.
   *
   * Pipeline:
   *  $search  — autocomplete on name/email/designation/employeeCode/mobile
   *             + compound.filter for workspaceId / deletion flags / isActive
   *  $match   — complex conditions that can't go in Atlas filter:
   *             dateOfResignation guards (active), appAccess $or, arbitrary filters
   *  $facet   — parallel data (sorted, paginated, $lookup role+shift) and count
   *
   * Return shape is identical to QueryHelper.paginate so findAll caller is
   * unchanged.
   */
  private async findAllWithAtlasSearch(
    workspaceId: string,
    options: PaginationDto,
    // Phase 6 — when non-null, the ORG-scoped member-cap allowed set. The Atlas
    // path constrains `_id` to it via a post-$search `$match` (Atlas `equals`
    // filters are single-valued, so `$in` goes in the $match stage). Null = no
    // cap (do not constrain).
    allowedObjectIds: Types.ObjectId[] | null = null,
  ): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    pages: number;
  }> {
    const { page = 1, limit = 10, sortBy, sortOrder = 'desc', search } = options;
    const skip = (page - 1) * limit;

    // ── Atlas compound.filter: equality/boolean/objectId pre-pruning ──────────
    // These conditions don't affect relevance score and reduce candidates early.
    const atlasFilters: Record<string, unknown>[] = [
      {
        equals: {
          path: 'workspaceId',
          value: new Types.ObjectId(workspaceId),
        },
      },
      { equals: { path: 'isPermanentlyDeleted', value: false } },
    ];

    if (options.status === 'archived') {
      atlasFilters.push({ equals: { path: 'isDeleted', value: true } });
    } else if (options.status !== 'all') {
      // default + active/inactive/offboarding: exclude soft-deleted
      atlasFilters.push({ equals: { path: 'isDeleted', value: false } });
      if (options.status === 'active' || options.status === 'offboarding') {
        atlasFilters.push({ equals: { path: 'isActive', value: true } });
      } else if (options.status === 'inactive') {
        atlasFilters.push({ equals: { path: 'isActive', value: false } });
      }
    }

    // ── Post-search $match: complex conditions Atlas filter can't express ──────
    // dateOfResignation $or guard (active), offboarding date range, appAccess $or.
    const matchConditions: Record<string, unknown>[] = [];

    // Phase 6 — ORG-scoped member cap: restrict to the allowed member set.
    if (allowedObjectIds) {
      matchConditions.push({ _id: { $in: allowedObjectIds } });
    }

    if (options.status === 'active') {
      // active = isActive:true AND no future/present resignation date
      matchConditions.push({
        $or: [{ dateOfResignation: { $exists: false } }, { dateOfResignation: null }],
      });
    } else if (options.status === 'offboarding') {
      // offboarding = isActive:true AND resignation date is set and in the future
      matchConditions.push({
        dateOfResignation: { $exists: true, $ne: null, $gt: new Date() },
      });
    }

    if (options.appAccess === 'active') {
      matchConditions.push({
        hasAppAccess: true,
        linkedUserId: { $exists: true, $ne: null },
      });
    } else if (options.appAccess === 'invited') {
      matchConditions.push({
        appAccessInviteToken: { $exists: true, $ne: null },
        appAccessInviteExpiry: { $gt: new Date() },
      });
    } else if (options.appAccess === 'none') {
      matchConditions.push({ hasAppAccess: false });
      matchConditions.push({
        $or: [
          { appAccessInviteToken: { $exists: false } },
          { appAccessInviteExpiry: { $lte: new Date() } },
        ],
      });
    }

    // Arbitrary field=value filters forwarded from the query (mirrors QueryHelper)
    const extraFilters = options.filters as Record<string, unknown> | null | undefined;
    if (extraFilters && typeof extraFilters === 'object') {
      for (const key of Object.keys(extraFilters)) {
        const value: unknown = extraFilters[key];
        if (value !== undefined && value !== null && value !== '') {
          const dbKey = key === 'id' ? '_id' : key;
          matchConditions.push({
            [dbKey]: Array.isArray(value) ? { $in: value } : value,
          });
        }
      }
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const sort: Record<string, 1 | -1> = sortBy
      ? { [sortBy]: sortOrder === 'asc' ? 1 : -1 }
      : { createdAt: -1 };

    // ── Aggregation pipeline ──────────────────────────────────────────────────
    // $search MUST be the first stage (Atlas requirement).
    const pipeline: Record<string, unknown>[] = [
      {
        $search: {
          index: 'team_members_search',
          compound: {
            // should + minimumShouldMatch:1 = OR across all search fields
            should: [
              { autocomplete: { query: search, path: 'name' } },
              { autocomplete: { query: search, path: 'email' } },
              { autocomplete: { query: search, path: 'designation' } },
              { autocomplete: { query: search, path: 'employeeCode' } },
              { autocomplete: { query: search, path: 'mobile' } },
            ],
            minimumShouldMatch: 1,
            filter: atlasFilters,
          },
        },
      },
    ];

    if (matchConditions.length > 0) {
      pipeline.push({
        $match: matchConditions.length === 1 ? matchConditions[0] : { $and: matchConditions },
      });
    }

    // $facet: run paginated data and total count in a single aggregation trip.
    // $lookup inside data replicates Mongoose populate for rbacRoleId + shiftId.
    pipeline.push({
      $facet: {
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'roles',
              let: { roleId: '$rbacRoleId' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$roleId'] } } },
                { $project: { _id: 1, name: 1, color: 1 } },
              ],
              as: 'rbacRoleId',
            },
          },
          // preserveNullAndEmptyArrays keeps members with no role assigned
          // (the correct $unwind option name; the misspelled variant is rejected
          // by modern MongoDB and silently drops unmatched rows on tolerant ones)
          { $unwind: { path: '$rbacRoleId', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'shifts',
              let: { shiftId: '$shiftId' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$shiftId'] } } },
                {
                  $project: {
                    _id: 1,
                    name: 1,
                    startTime: 1,
                    endTime: 1,
                    color: 1,
                  },
                },
              ],
              as: 'shiftId',
            },
          },
          // preserveNullAndEmptyArrays keeps members with no shift assigned
          { $unwind: { path: '$shiftId', preserveNullAndEmptyArrays: true } },
        ],
        count: [{ $count: 'total' }],
      },
    });

    type FacetResult = {
      data: Record<string, unknown>[];
      count: [{ total: number }] | [];
    };

    const aggResult = await this.teamModel
      .aggregate<FacetResult>(pipeline as Parameters<typeof this.teamModel.aggregate>[0])
      .exec();

    const facet: FacetResult = aggResult[0] ?? { data: [], count: [] };
    const total = facet.count[0]?.total ?? 0;

    return {
      data: facet.data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Get all team members for a workspace with pagination/filtering.
   * @param caMode When true, strips all non-tax fields from each member (CA role data minimization).
   */
  /**
   * Phase 6 (member-cap read filter) — resolve the allowed-member set + cap
   * status for an ORG-scoped roster read. Returns `null` when the cap service is
   * not wired (positional unit tests). Best-effort: never throws — a failure
   * resolving the cap must not break the list read, so it falls back to "no
   * cap" (status null, allowedObjectIds null = do-not-filter). Also fires the
   * lazy `reconcileWorkspace` (fire-and-forget) so an over-cap workspace's grace
   * clock + notice reflect immediately on the canonical roster view without
   * waiting for the nightly cron.
   */
  private async resolveTeamMemberCap(workspaceId: string): Promise<{
    allowedObjectIds: Types.ObjectId[] | null;
    status: { capped: boolean; visibleCount: number; totalCount: number; limit: number } | null;
  } | null> {
    if (!this.memberCap) return null;
    // Lazy reconcile — fire-and-forget. A thrown reconcile must NOT break the
    // read, so it is fully detached + catch-guarded.
    void this.memberCap.reconcileWorkspace(workspaceId).catch((err: unknown) => {
      this.logger.warn(
        `member-cap lazy reconcile failed for ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    try {
      const status = await this.memberCap.getCapStatus(workspaceId);
      // Only constrain the query when the cap is actually biting. When not
      // capped, getAllowedMemberIds returns everyone, so injecting it is a
      // no-op — but we skip the extra query + filter entirely to keep the
      // common (uncapped) path cheap.
      const allowed = status.capped
        ? (await this.memberCap.getAllowedMemberIds(workspaceId)).map(
            (id) => new Types.ObjectId(id),
          )
        : null;
      return {
        allowedObjectIds: allowed,
        status: {
          capped: status.capped,
          visibleCount: status.visibleCount,
          totalCount: status.totalCount,
          limit: status.limit,
        },
      };
    } catch (err) {
      this.logger.warn(
        `member-cap status resolve failed for ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async findAll(
    workspaceId: string,
    options: PaginationDto & { isKarigar?: boolean },
    caMode: boolean,
    userId: string,
  ) {
    return this.withTeamSpan('team.findAll', { workspaceId }, async () => {
      const startMs = Date.now();

      // ── §7 Part B — self-scope narrowing ─────────────────────────────────────
      // A caller whose effective `team.directory.view` grant is `scope: 'self'` may see
      // only their own directory row. Scope is resolved from live RBAC (role +
      // per-member overrides) via CallerScopeService — not hardcoded. `self`
      // forces `_id` to the caller's own row below; a self-scoped caller with no
      // directory row yields an impossible filter → empty result (fail-closed).
      // `all`-scoped callers and owners → `selfAnchor === null` (unaffected).
      const scopeCtx = await this.callerScope.resolve(workspaceId, userId);
      const selfAnchor = this.callerScope.selfPathFilterValue(scopeCtx, 'team.directory.view');

      // ── Member-cap (Phase 6) — ORG-scoped reads only ─────────────────────────
      // A downgraded / over-limit workspace behaves as if only the allowed
      // members exist (owner + oldest (limit-1) by join date) once the grace
      // window has elapsed. We resolve the cap ONLY on the org-scoped path
      // (`selfAnchor === null`): a self-scoped caller already sees only their own
      // row, is never capped, and must not have the cap interfere with the self
      // narrowing below. `allowedObjectIds` is non-null only when the cap is
      // actually biting; `status` is surfaced to the response as an OPTIONAL
      // `memberCap` field so the web can show "Showing N of TOTAL — upgrade".
      const memberCap = selfAnchor === null ? await this.resolveTeamMemberCap(workspaceId) : null;

      // ── Atlas Search path ────────────────────────────────────────────────────
      // Engages only when the feature flag is on AND a search term is present.
      // Empty-query list loads (no search) still use the indexed regex path which
      // is fast for full-collection scans with workspaceId + status indexes.
      // Bypassed for self-scoped callers — they resolve to at most one row, so
      // the regex path with the `_id` filter is correct and cheaper.
      if (this.atlasSearchEnabled && options.search && selfAnchor === null) {
        const result = await this.findAllWithAtlasSearch(
          workspaceId,
          options,
          memberCap?.allowedObjectIds ?? null,
        );
        this.logger.log(
          `team.findAll [atlas] ws=${workspaceId} q="${options.search}" total=${result.total} ${Date.now() - startMs}ms`,
        );
        return {
          success: true,
          data: {
            ...result,
            // Phase 6 — optional cap notice. Present only on org-scoped reads.
            ...(memberCap?.status ? { memberCap: memberCap.status } : {}),

            members: result.data.map((m) => {
              const resp = this.toResponse(m as TeamMember);
              return caMode
                ? transformForCaRole(resp)
                : filterTeamMemberRead(resp, {
                    isOwner: scopeCtx.isOwner,
                    isOwnRecord:
                      String((m as { _id?: unknown })._id) === String(scopeCtx.teamMemberId),
                    hasPath: (p, s) => this.callerScope.hasPath(scopeCtx, p, s),
                  });
            }),
          },
        };
      }

      // ── Regex/index path (default or Atlas disabled) ─────────────────────────
      // Always exclude permanently deleted members
      let baseFilter: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
        isPermanentlyDeleted: { $ne: true },
      };

      if (options.status === 'archived') {
        baseFilter = { ...baseFilter, isDeleted: true };
      } else if (options.status === 'all') {
        // 'all' returns ALL members including archived (for client-side filtering)
        // Still excludes permanently deleted
      } else {
        baseFilter = { ...baseFilter, isDeleted: { $ne: true } };

        if (options.status === 'active') {
          baseFilter.isActive = true;
          baseFilter.$or = [{ dateOfResignation: { $exists: false } }, { dateOfResignation: null }];
        } else if (options.status === 'inactive') {
          baseFilter.isActive = false;
        } else if (options.status === 'offboarding') {
          baseFilter.isActive = true;
          baseFilter.dateOfResignation = {
            $exists: true,
            $ne: null,
            $gt: new Date(),
          };
        }
      }

      if (options.appAccess === 'active') {
        Object.assign(baseFilter, {
          hasAppAccess: true,
          linkedUserId: { $exists: true, $ne: null },
        });
      } else if (options.appAccess === 'invited') {
        Object.assign(baseFilter, {
          appAccessInviteToken: { $exists: true, $ne: null },
          appAccessInviteExpiry: { $gt: new Date() },
        });
      } else if (options.appAccess === 'none') {
        Object.assign(baseFilter, {
          hasAppAccess: false,
          $or: [
            { appAccessInviteToken: { $exists: false } },
            { appAccessInviteExpiry: { $lte: new Date() } },
          ],
        });
      }

      // isKarigar filter — used by JWI/JWO karigar picker (D-06)
      if (options.isKarigar === true) {
        baseFilter.isKarigar = true;
      }

      // §7 Part B — apply self-scope last so it wins over any client-supplied
      // status / search / appAccess filter. A self-scoped worker cannot widen
      // the list by passing a different status or query.
      if (selfAnchor === 'no-self-anchor') {
        baseFilter._id = new Types.ObjectId(); // matches nothing
      } else if (selfAnchor) {
        baseFilter._id = selfAnchor;
      } else if (memberCap?.allowedObjectIds) {
        // Phase 6 — ORG-scoped cap. `selfAnchor === null` here (self branches
        // handled above), so this only constrains an org-wide reader. Non-null
        // `allowedObjectIds` means the cap is biting; restrict `_id` to the
        // allowed set so an over-limit workspace lists only the grandfathered
        // members. A no-op when not capped (allowedObjectIds is null then).
        baseFilter._id = { $in: memberCap.allowedObjectIds };
      }

      const result = await QueryHelper.paginate(
        this.teamModel,
        baseFilter,
        options,
        ['name', 'mobile', 'designation', 'email', 'employeeCode'],
        [ROLE_POPULATE, SHIFT_POPULATE],
      );

      this.logger.log(
        `team.findAll [regex] ws=${workspaceId} q="${options.search ?? ''}" total=${result.total} ${Date.now() - startMs}ms`,
      );

      return {
        success: true,
        data: {
          ...result,
          // Phase 6 — optional cap notice. Present only on org-scoped reads.
          ...(memberCap?.status ? { memberCap: memberCap.status } : {}),

          members: result.data.map((m) => {
            const resp = this.toResponse(m);
            return caMode
              ? transformForCaRole(resp)
              : filterTeamMemberRead(resp, {
                  isOwner: scopeCtx.isOwner,
                  isOwnRecord:
                    String((m as { _id?: unknown })._id) === String(scopeCtx.teamMemberId),
                  hasPath: (p, s) => this.callerScope.hasPath(scopeCtx, p, s),
                });
          }),
        },
      };
    });
  }

  /**
   * Get single member - verify they belong to the workspace.
   * @param caMode When true, strips all non-tax fields (CA role data minimization).
   */
  async findById(workspaceId: string, memberId: string, caMode: boolean, userId: string) {
    return this.withTeamSpan('team.findById', { workspaceId, memberId }, async () => {
      // §7 Part B — a self-scoped caller may resolve only their own row.
      // Resolve the scope context once: it gates the read AND drives the
      // read-side field-group filtering below (avoids a second resolve).
      const ctx = await this.callerScope.resolve(workspaceId, userId);
      this.assertReadScopeWithCtx(ctx, memberId);
      const member = await this.teamModel
        .findOne({
          _id: memberId,
          workspaceId: new Types.ObjectId(workspaceId),
          isPermanentlyDeleted: { $ne: true },
        })
        .populate(ROLE_POPULATE)
        .populate(SHIFT_POPULATE)
        .populate(GRANTED_BY_POPULATE)
        .exec();
      if (!member) throw new NotFoundException('Team member not found');
      const resp = this.toResponse(member);
      // CA-role data minimization OR per-field-group read filtering: strip
      // every profile group the caller lacks `*.view` on, so a directory-
      // viewer never receives bank / pay / statutory PII it cannot see.
      const visible = caMode
        ? transformForCaRole(resp)
        : filterTeamMemberRead(resp, {
            isOwner: ctx.isOwner,
            isOwnRecord: String(ctx.teamMemberId) === String(memberId),
            hasPath: (p, s) => this.callerScope.hasPath(ctx, p, s),
          });
      return {
        success: true,

        data: { member: visible },
      };
    });
  }

  /**
   * Resolve (and lazily persist) the workspace's immutable short code — the
   * {WS} token embedded in every employee code. New workspaces get it at
   * create time (workspaces.service); this backfills legacy workspaces on
   * first employee create / backfill so the code is workspace-scoped by value.
   * Globally unique: suffixes a number on collision. Single source of truth =
   * Workspace.workspaceCode.
   */
  private async ensureWorkspaceCode(
    workspaceModel: Model<any>,
    workspace: { _id: Types.ObjectId; name?: string; workspaceCode?: string },
  ): Promise<string> {
    if (workspace.workspaceCode) return workspace.workspaceCode;
    const base = deriveWorkspaceCodeBase(workspace.name);
    let candidate = base;
    for (let i = 1; i < 1000; i++) {
      const clash = await workspaceModel
        .findOne({ workspaceCode: candidate, _id: { $ne: workspace._id } })
        .select('_id')
        .lean()
        .exec();
      if (!clash) break;
      candidate = `${base.slice(0, 4)}${i}`;
    }
    await workspaceModel
      .updateOne({ _id: workspace._id }, { $set: { workspaceCode: candidate } })
      .exec();
    workspace.workspaceCode = candidate;
    return candidate;
  }

  /**
   * Create member - check subscription seat limit before creating
   */
  async create(workspaceId: string, userId: string, createDto: CreateTeamMemberDto) {
    return this.withTeamSpan('team.create', { workspaceId, userId }, async () => {
      const subscriptionModel = this.moduleRef.get<Model<SubscriptionDoc>>(
        getModelToken('Subscription'),
        { strict: false },
      );
      const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
        strict: false,
      });

      const workspace = await workspaceModel.findById(new Types.ObjectId(workspaceId)).exec();

      if (!workspace) {
        throw new NotFoundException('Workspace not found');
      }

      // RBAC §6/§7 — field-group authorization. `team.member.create` (route
      // guard) covers the member row + non-sensitive fields; sensitive groups
      // (pay / bank / statutory / org) each need their own `.edit` grant so a
      // non-owner cannot seed a new hire's salary or bank details unsupervised.
      const callerCtx = await this.callerScope.resolve(workspaceId, userId);
      this.assertTeamFieldGroupGrants(callerCtx, createDto, {
        isOwnRecord: false,
        sensitiveOnly: true,
      });

      const ownerId = workspace.ownerId.toString();
      this.logger.debug(
        `create lookup owner=${ownerId} workspace=${workspaceId} user=${userId} name=${createDto.name}`,
      );

      const subscription = await subscriptionModel
        .findOne({
          userId: new Types.ObjectId(ownerId),
          status: { $in: ['active', 'trial'] },
        })
        .select('appliedEntitlements purchasedEntitlements status')
        .populate('planId')
        .lean()
        .exec();

      this.logger.debug(
        `create subscription owner=${ownerId} hasSub=${!!subscription} status=${subscription?.status ?? '-'} perWs=${subscription?.appliedEntitlements?.maxMembersPerWorkspace ?? '-'} total=${subscription?.appliedEntitlements?.maxTotalMembers ?? '-'}`,
      );

      // If no subscription found, use default limits
      if (!subscription) {
        this.logger.debug('create no subscription, using default limits');
        const defaultPerWorkspaceLimit = 5;
        const defaultTotalLimit = 5;

        // Count ALL members including archived (but exclude permanently deleted)
        const currentCount = await this.teamModel
          .countDocuments({
            workspaceId: new Types.ObjectId(workspaceId),
            isPermanentlyDeleted: { $ne: true },
          })
          .exec();

        this.logger.debug(
          `create default per-workspace check limit=${defaultPerWorkspaceLimit} current=${currentCount}`,
        );

        if (currentCount >= defaultPerWorkspaceLimit) {
          throw new HttpException(
            {
              success: false,
              message: `Team member limit reached for this workspace. Your current plan allows up to ${defaultPerWorkspaceLimit} members per workspace (${currentCount} currently).`,
              code: 'SEAT_LIMIT_REACHED',
              limit: defaultPerWorkspaceLimit,
              current: currentCount,
              upgradeUrl: '/subscription/upgrade',
              requestMoreSeats: true,
            },
            HttpStatus.FORBIDDEN,
          );
        }

        const workspaceModelDefault = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
          strict: false,
        });
        const ownedWorkspaces = await workspaceModelDefault
          .find({ ownerId: new Types.ObjectId(ownerId) })
          .select('_id')
          .exec();
        // Count ALL members including archived (but exclude permanently deleted)
        const totalCount = await this.teamModel
          .countDocuments({
            workspaceId: { $in: ownedWorkspaces.map((w) => w._id) },
            isPermanentlyDeleted: { $ne: true },
          })
          .exec();

        this.logger.debug(
          `create default total check limit=${defaultTotalLimit} current=${totalCount}`,
        );

        if (totalCount >= defaultTotalLimit) {
          throw new HttpException(
            {
              success: false,
              message: `Total team member limit reached. Your current plan allows up to ${defaultTotalLimit} members total (${totalCount} currently).`,
              code: 'TOTAL_SEAT_LIMIT_REACHED',
              limit: defaultTotalLimit,
              current: totalCount,
              upgradeUrl: '/subscription/upgrade',
              requestMoreSeats: true,
            },
            HttpStatus.FORBIDDEN,
          );
        }
      }

      if (subscription?.appliedEntitlements) {
        const perWorkspaceLimit = subscription.appliedEntitlements.maxMembersPerWorkspace;
        const totalLimit = subscription.appliedEntitlements.maxTotalMembers;

        // Count ALL members including archived (but exclude permanently deleted)
        const currentCount = await this.teamModel
          .countDocuments({
            workspaceId: workspaceId,
            isPermanentlyDeleted: { $ne: true },
          })
          .exec();

        // Debug: List all team members in this workspace (exclude permanently deleted)
        const allMembers = await this.teamModel
          .find({ workspaceId: workspaceId, isPermanentlyDeleted: { $ne: true } })
          .select('name isActive')
          .exec();

        this.logger.debug(
          `create per-workspace check workspace=${workspaceId} limit=${perWorkspaceLimit} current=${currentCount} active=${allMembers.filter((m) => m.isActive).length} inactive=${allMembers.filter((m) => !m.isActive).length} willBlock=${perWorkspaceLimit !== -1 && currentCount >= perWorkspaceLimit}`,
        );

        // FORCE BLOCK if limit reached - bypass all other checks
        if (perWorkspaceLimit !== -1 && currentCount >= perWorkspaceLimit) {
          this.logger.warn('create BLOCKED per-workspace limit reached');
          throw new HttpException(
            {
              success: false,
              message: `Team member limit reached for this workspace. Your current plan allows up to ${perWorkspaceLimit} members per workspace (${currentCount} currently).`,
              code: 'SEAT_LIMIT_REACHED',
              limit: perWorkspaceLimit,
              current: currentCount,
              upgradeUrl: '/subscription/upgrade',
              requestMoreSeats: true,
            },
            HttpStatus.FORBIDDEN,
          );
        }

        // Check total limit across all workspaces
        if (totalLimit !== -1) {
          const workspaces = await workspaceModel.find({ ownerId: ownerId }).select('_id').exec();
          const workspaceIds = workspaces.map((w) => w._id.toString());

          // Count ALL members including archived (but exclude permanently deleted)
          const totalCount = await this.teamModel
            .countDocuments({
              workspaceId: { $in: workspaceIds },
              isPermanentlyDeleted: { $ne: true },
            })
            .exec();

          this.logger.debug(
            `create total check owner=${ownerId} workspaces=${workspaceIds.length} limit=${totalLimit} current=${totalCount} willBlock=${totalCount >= totalLimit}`,
          );

          if (totalCount >= totalLimit) {
            this.logger.warn('create BLOCKED total limit reached');
            throw new HttpException(
              {
                success: false,
                message: `Total team member limit reached across all workspaces. Your current plan allows up to ${totalLimit} members total (${totalCount} currently).`,
                code: 'TOTAL_SEAT_LIMIT_REACHED',
                limit: totalLimit,
                current: totalCount,
                upgradeUrl: '/subscription/upgrade',
                requestMoreSeats: true,
              },
              HttpStatus.FORBIDDEN,
            );
          }
        }
      }

      this.logger.debug('create limit checks passed, creating member');

      await this.assertUniqueIdentifiers(workspaceId, createDto);
      this.assertDateCoherence(createDto);

      // ── Validate / re-derive location (mirrors MachinesService.create) ──
      // Defense-in-depth: ensure at least one Location exists so direct API
      // callers (and first-time single-site shops) never face an empty picker.
      // Idempotent + cheap (count-then-maybe-create), safe to call every time.
      await this.locationsService.ensureDefaultLocation(workspaceId);
      // Only validate when a locationId is supplied — legacy members and clients
      // that send only the free-text `location` (or nothing) must keep working.
      if (createDto.locationId) {
        const location = await this.locationModel
          .findOne({
            _id: new Types.ObjectId(createDto.locationId),
            workspaceId: new Types.ObjectId(workspaceId),
            isDeleted: false,
          })
          .exec();
        if (!location) {
          throw new BadRequestException('Invalid locationId for this workspace');
        }
        // Re-derive the denormalised `location` NAME from the resolved Location
        // so the stored name and locationId can never drift apart, regardless of
        // what (stale) name the client sent alongside the id.
        createDto.location = location.name;
      }

      // ── Resolve employee code (P3) ─────────────────────────────────────
      // Fall back to DEFAULT_AUTO_CODE_SETTINGS (enabled) when the workspace
      // never configured settings, so auto-generation is the default.
      const settings =
        (workspace.employeeCodeSettings as EmployeeCodeSettings | undefined) ??
        DEFAULT_AUTO_CODE_SETTINGS;
      // Employee code is ALWAYS system-generated, immutable, and non-replaceable
      // (owner request 2026-06-13): any client-supplied createDto.employeeCode is
      // IGNORED. The per-workspace counter drives the sequence; the workspace
      // code is embedded as the {WS} token so every code names its workspace.
      const workspaceCode = await this.ensureWorkspaceCode(workspaceModel, workspace);

      let resolvedCode: string | undefined;
      let reservedSequence: number | undefined;
      let codeBumped = false;

      if (settings?.enabled) {
        reservedSequence = await this.workspaceCounterService.reserveNextCode(workspaceId);
        resolvedCode = renderEmployeeCode(
          settings.format,
          settings.prefix,
          reservedSequence,
          workspaceCode,
        );
      }

      // Phase 1f.1 — mobile OTP proof token. Optional. When present, validate
      // the JWT and stamp mobileVerifiedAt / mobileVerifiedBy. When absent,
      // leave null (verification was skipped, grant-access flow OTP still
      // happens at invite-accept time as before).
      let mobileVerifiedAt: Date | null = null;
      let mobileVerifiedByOid: Types.ObjectId | null = null;
      if (createDto.mobileVerifyToken && createDto.mobile) {
        await this.mobileOtpService.assertProofToken(
          workspaceId,
          createDto.mobile,
          createDto.mobileVerifyToken,
        );
        mobileVerifiedAt = new Date();
        mobileVerifiedByOid = new Types.ObjectId(userId);
      }

      // Explicit cast: when createPayload is typed as Record<string, any>,
      // Mongoose v8 does NOT auto-cast string → ObjectId for the workspaceId
      // path in this construction. The new doc gets persisted with
      // `workspaceId: "<24-hex>"` (string) and every subsequent
      // `findOne({ workspaceId: new Types.ObjectId(...) })` misses it,
      // surfacing as a 404 immediately after a successful create. Casting
      // here matches what `findById` / `findAll` already do on the read side.
      const createPayload: Record<string, any> = {
        ...createDto,
        workspaceId: new Types.ObjectId(workspaceId),
        createdBy: new Types.ObjectId(userId),
        mobileVerifiedAt,
        mobileVerifiedBy: mobileVerifiedByOid,
      };
      if (resolvedCode) {
        createPayload.employeeCode = resolvedCode;
      } else {
        delete createPayload.employeeCode;
      }
      // Strip the proof token - it is not a schema field.
      delete createPayload.mobileVerifyToken;

      let savedMember: TeamMember;
      try {
        savedMember = await new this.teamModel(createPayload).save();
      } catch (err) {
        if (isIndexDuplicate(err, 'mobile')) {
          throw new ConflictException(
            `MEMBER_MOBILE_CONFLICT:A team member with mobile ${createDto.mobile} already exists in this workspace`,
          );
        }
        if (isIndexDuplicate(err, 'email')) {
          throw new ConflictException(
            `MEMBER_EMAIL_CONFLICT:A team member with email ${createDto.email} already exists in this workspace`,
          );
        }
        if (settings?.enabled && isEmployeeCodeDuplicate(err)) {
          // Auto-generated collision — retry once with the next counter value.
          const retrySeq = await this.workspaceCounterService.reserveNextCode(workspaceId);
          resolvedCode = renderEmployeeCode(
            settings.format,
            settings.prefix,
            retrySeq,
            workspaceCode,
          );
          reservedSequence = retrySeq;
          codeBumped = true;
          try {
            savedMember = await new this.teamModel({
              ...createPayload,
              employeeCode: resolvedCode,
            }).save();
          } catch (retryErr) {
            if (isEmployeeCodeDuplicate(retryErr)) {
              throw new HttpException(
                {
                  success: false,
                  code: 'EMP_CODE_CONFLICT',
                  message: 'Employee code collision after retry. Please try again.',
                },
                HttpStatus.CONFLICT,
              );
            }
            throw retryErr;
          }
        } else {
          throw err;
        }
      }

      // Re-fetch with populated fields
      const populated = await this.teamModel
        .findById(savedMember._id)
        .populate(ROLE_POPULATE)
        .populate(SHIFT_POPULATE)
        .exec();

      const responseData: Record<string, any> = {
        member: this.toResponse(populated ?? savedMember),
      };
      if (codeBumped && resolvedCode) {
        responseData.employeeCodeNotice = {
          code: 'EMP_CODE_BUMPED',
          assigned: resolvedCode,
          sequence: reservedSequence,
        };
      }

      this.auditTeamEvent({
        action: 'team.member_created',
        workspaceId,
        actorId: userId,
        memberId: savedMember._id,
        actorNameSnapshot: savedMember.name,
        meta: {
          salaryType: savedMember.salaryType,
          isKarigar: savedMember.isKarigar,
          employeeCode: resolvedCode ?? null,
          codeBumped,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'team.member_created',
        properties: {
          workspaceId,
          memberId: savedMember._id.toString(),
          salaryType: savedMember.salaryType,
          isKarigar: savedMember.isKarigar,
        },
      });

      return {
        success: true,
        data: responseData,
      };
    });
  }

  /**
   * Update member fields
   */
  async update(
    workspaceId: string,
    memberId: string,
    updateDto: UpdateTeamMemberDto,
    userId: string,
  ) {
    return this.withTeamSpan('team.update', { workspaceId, memberId }, async () => {
      // §7 Part B — scope + separation-of-duty guard. Throws before any
      // mutation when the caller is out of `team.edit` scope, or is a
      // non-owner self-editing a restricted (non-personal) field.
      await this.assertProfileUpdateAllowed(workspaceId, userId, memberId, updateDto);
      // Cast workspaceId — Mongoose v8 query cast can miss string→ObjectId for
      // docs persisted via the explicit-cast create path (see L1029-1038),
      // surfacing as a spurious "Team member not found" on PATCH even though
      // GET resolves the same doc. Mirror findById's explicit cast.
      const workspaceIdObj = new Types.ObjectId(workspaceId);
      // Fetch current member to check for file replacements
      const currentMember = await this.teamModel
        .findOne({
          _id: memberId,
          workspaceId: workspaceIdObj,
          isPermanentlyDeleted: { $ne: true },
        })
        .exec();
      if (!currentMember) throw new NotFoundException('Team member not found');

      await this.assertUniqueIdentifiers(workspaceId, updateDto, memberId);
      this.assertDateCoherence(updateDto);

      // ── Validate / re-derive location (mirrors MachinesService.update) ──
      // Only validate when the caller is actually changing locationId. Updates
      // that don't touch locationId (e.g. editing name/pay on a legacy member
      // that only has the free-text `location`) must NOT be blocked here.
      if (updateDto.locationId) {
        const location = await this.locationModel
          .findOne({
            _id: new Types.ObjectId(updateDto.locationId),
            workspaceId: workspaceIdObj,
            isDeleted: false,
          })
          .exec();
        if (!location) {
          throw new BadRequestException('Invalid locationId for this workspace');
        }
        // Keep the denormalised `location` NAME in lock-step with locationId so
        // the two can never drift, even if the client sent a stale/empty name.
        (updateDto as Record<string, unknown>).location = location.name;
      }

      // Phase 1f.1 — mobile OTP proof on number change.
      // When the mobile is changing, either supply a fresh proof token (stamps
      // mobileVerifiedAt) or omit it (clears mobileVerifiedAt, verification
      // status does not carry over to a new number).
      if (updateDto.mobile && updateDto.mobile !== currentMember.mobile) {
        if (updateDto.mobileVerifyToken) {
          await this.mobileOtpService.assertProofToken(
            workspaceId,
            updateDto.mobile,
            updateDto.mobileVerifyToken,
          );
          (updateDto as Record<string, unknown>).mobileVerifiedAt = new Date();
          (updateDto as Record<string, unknown>).mobileVerifiedBy = new Types.ObjectId(userId);
        } else {
          (updateDto as Record<string, unknown>).mobileVerifiedAt = null;
          (updateDto as Record<string, unknown>).mobileVerifiedBy = null;
        }
      }

      // Handle unsetting fields when explicitly set to null/undefined
      const updateObj: Record<string, any> = { ...updateDto };
      // Employee code is immutable after creation — strip defensively.
      delete updateObj.employeeCode;
      // Proof token is not a schema field — strip before persisting.
      delete updateObj.mobileVerifyToken;
      const unsetFields: string[] = [];

      if (updateObj.dateOfResignation === undefined || updateObj.dateOfResignation === null) {
        unsetFields.push('dateOfResignation');
        delete updateObj.dateOfResignation;
      }
      if (updateObj.resignationNote === undefined || updateObj.resignationNote === null) {
        unsetFields.push('resignationNote');
        delete updateObj.resignationNote;
      }
      if (updateObj.finalMonthlyOverride === undefined || updateObj.finalMonthlyOverride === null) {
        unsetFields.push('finalMonthlyOverride');
        delete updateObj.finalMonthlyOverride;
      }
      if (
        updateObj.minimumWageMonthlyOverride === undefined ||
        updateObj.minimumWageMonthlyOverride === null
      ) {
        unsetFields.push('minimumWageMonthlyOverride');
        delete updateObj.minimumWageMonthlyOverride;
      }
      if (updateObj.workingDays === null) {
        unsetFields.push('workingDays');
        delete updateObj.workingDays;
      }
      if (updateObj.esiApplicable === false) {
        unsetFields.push('esiIpNumber');
        delete updateObj.esiIpNumber;
      }
      if (updateObj.reportsTo === undefined || updateObj.reportsTo === null) {
        unsetFields.push('reportsTo');
        delete updateObj.reportsTo;
      }

      const updateQuery: any = { $set: updateObj };
      if (unsetFields.length > 0) {
        updateQuery.$unset = {};
        unsetFields.forEach((field) => {
          updateQuery.$unset[field] = 1;
        });
      }

      // Delete old files if they're being replaced.
      // Wave-3 Drift #36 — pass workspaceId for storage-quota refund.
      // fileSizeBytes not tracked; counter drifts (recoverable via recompute script).
      if (updateDto.avatar && currentMember.avatar && updateDto.avatar !== currentMember.avatar) {
        await this.uploadsService.deleteFile(currentMember.avatar, workspaceId);
      }
      if (
        updateDto.bankDetails?.passbookImageUrl &&
        currentMember.bankDetails?.passbookImageUrl &&
        updateDto.bankDetails.passbookImageUrl !== currentMember.bankDetails.passbookImageUrl
      ) {
        await this.uploadsService.deleteFile(
          currentMember.bankDetails.passbookImageUrl,
          workspaceId,
        );
      }
      if (
        updateDto.upiDetails?.qrCodeUrl &&
        currentMember.upiDetails?.qrCodeUrl &&
        updateDto.upiDetails.qrCodeUrl !== currentMember.upiDetails.qrCodeUrl
      ) {
        await this.uploadsService.deleteFile(currentMember.upiDetails.qrCodeUrl, workspaceId);
      }

      let member;
      try {
        member = await this.teamModel
          .findOneAndUpdate({ _id: memberId, workspaceId: workspaceIdObj }, updateQuery, {
            new: true,
          })
          .populate(ROLE_POPULATE)
          .populate(SHIFT_POPULATE)
          .exec();
      } catch (err) {
        if (isIndexDuplicate(err, 'mobile')) {
          throw new ConflictException(
            `MEMBER_MOBILE_CONFLICT:A team member with mobile ${updateDto.mobile} already exists in this workspace`,
          );
        }
        if (isIndexDuplicate(err, 'email')) {
          throw new ConflictException(
            `MEMBER_EMAIL_CONFLICT:A team member with email ${updateDto.email} already exists in this workspace`,
          );
        }
        throw err;
      }
      if (!member) throw new NotFoundException('Team member not found');

      this.auditTeamEvent({
        action: 'team.member_updated',
        workspaceId,
        actorId: userId,
        memberId,
        actorNameSnapshot: member.name,
        meta: { fieldsChanged: Object.keys(updateDto) },
      });

      return {
        success: true,

        data: { member: this.toResponse(member) },
      };
    });
  }

  /**
   * Soft delete - archive a member (isDeleted = true)
   * Does NOT delete S3 files - they are preserved for potential restore
   */
  async remove(workspaceId: string, memberId: string, actorId: string) {
    return this.withTeamSpan('team.remove', { workspaceId, memberId }, async () => {
      this.logger.log(`remove archive workspace=${workspaceId} member=${memberId}`);

      // 2026-05-22 idempotency + ObjectId cast: look up the row without the
      // isDeleted / isPermanentlyDeleted filters so an already-archived (or
      // already permanently-deleted) row is a NO-OP success instead of a
      // 404. Explicit Types.ObjectId casts mirror every other write in this
      // service. The previous string-only query relied on Mongoose's
      // implicit cast which, with the schema's union type
      // (`Workspace | Types.ObjectId`), did not always cast - resulting in
      // string-vs-ObjectId comparison mismatch in Mongo and every archive
      // attempt returning 404 "Team member not found".
      const wsOid = new Types.ObjectId(workspaceId);
      const memOid = new Types.ObjectId(memberId);

      const member = await this.teamModel.findOne({ _id: memOid, workspaceId: wsOid }).exec();
      if (!member) {
        // Diagnostic: when the (id + workspace) filter misses, try id only so
        // the log tells us whether the row is missing entirely or attached to
        // a different workspace. Helps debug 404s on rows the list view shows.
        const orphan = await this.teamModel.findById(memOid).exec();
        if (orphan) {
          this.logger.warn(
            `remove member found but in different workspace ` +
              `requested=${workspaceId} actual=${String(orphan.workspaceId)} member=${memberId}`,
          );
        } else {
          this.logger.warn(
            `remove member missing from collection workspace=${workspaceId} member=${memberId}`,
          );
        }
        throw new NotFoundException('Team member not found');
      }

      if (member.isPermanentlyDeleted) {
        this.logger.warn(
          `remove no-op (already permanently deleted) workspace=${workspaceId} member=${memberId}`,
        );
        return { success: true, message: 'Already removed permanently', data: null };
      }
      if (member.isDeleted) {
        this.logger.warn(
          `remove no-op (already archived) workspace=${workspaceId} member=${memberId}`,
        );
        return { success: true, message: 'Already archived', data: null };
      }

      this.logger.log(`remove archiving member=${member._id.toString()} name=${member.name}`);

      // Soft delete: mark archived, unlink user account, revoke app access
      // IMPORTANT: Do NOT delete S3 files — they are preserved for potential restore
      // IMPORTANT: Do NOT touch the User document — it belongs to the auth system, not this workspace
      await this.teamModel
        .updateOne(
          { _id: memOid, workspaceId: wsOid },
          {
            isDeleted: true,
            deletedAt: new Date(),
            isActive: false,
            hasAppAccess: false,
            linkedUserId: null,
            appAccessInviteToken: null,
            appAccessInviteExpiry: null,
          },
        )
        .exec();

      // Workstream G (Salary hardening) — fire the salary-side removal cascade:
      // pause active commission schedules, cancel pending advance requests, and
      // alert the owner about any open employer loan. Resolved lazily via
      // moduleRef (forwardRef cycle TeamModule<->SalaryModule) so the Team
      // constructor stays untouched. Best-effort: a salary-cascade failure must
      // never block the member soft-delete (the offboard write-lock + retention
      // job still protect the retained statutory rows). See
      // SalaryLifecycleService.onMemberRemoved + DATA-MAP-AND-RETENTION §4.
      try {
        const salaryLifecycle = this.moduleRef.get<SalaryLifecycleService>(SalaryLifecycleService, {
          strict: false,
        });
        await salaryLifecycle?.onMemberRemoved(workspaceId, memberId, actorId);
      } catch (err) {
        this.logger.warn(
          `salary onMemberRemoved cascade failed (non-fatal) ws=${workspaceId} member=${memberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }

      // Attendance hardening (OQ-A1 / OQ-A6) — fire the attendance-side removal
      // cascade: IMMEDIATELY scrub the kiosk physical-access credential
      // (kioskPinHash + lockout) on the just-soft-deleted member. Resolved lazily
      // via moduleRef (forwardRef cycle TeamModule<->AttendanceModule). Best-effort:
      // an attendance-cascade failure must never block the member soft-delete (the
      // kiosk `isDeleted:false` guard + the MEMBER_OFFBOARDED write-lock still
      // protect the removed member). See AttendanceLifecycleService.onMemberRemoved.
      try {
        const attendanceLifecycle = this.moduleRef.get<AttendanceLifecycleService>(
          AttendanceLifecycleService,
          { strict: false },
        );
        await attendanceLifecycle?.onMemberRemoved(workspaceId, memberId, actorId);
      } catch (err) {
        this.logger.warn(
          `attendance onMemberRemoved cascade failed (non-fatal) ws=${workspaceId} member=${memberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }

      this.auditTeamEvent({
        action: 'team.member_archived',
        workspaceId,
        actorId,
        memberId,
        actorNameSnapshot: member.name,
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.member_archived',
        properties: { workspaceId, memberId },
      });

      return { success: true, message: 'Team member archived', data: null };
    });
  }

  /**
   * Restore an archived member
   */
  async restore(workspaceId: string, memberId: string, actorId: string) {
    return this.withTeamSpan('team.restore', { workspaceId, memberId }, async () => {
      // 2026-05-22: explicit Types.ObjectId casts. Same fix as remove():
      // the schema's `workspaceId: Workspace | Types.ObjectId` union type
      // suppresses Mongoose's implicit string-to-ObjectId cast on certain
      // query paths, so raw string comparison never matches Mongo's stored
      // ObjectId values. Mirror the pattern used everywhere else in this
      // service.
      const wsOid = new Types.ObjectId(workspaceId);
      const memOid = new Types.ObjectId(memberId);

      const member = await this.teamModel
        .findOne({ _id: memOid, workspaceId: wsOid, isDeleted: true })
        .exec();
      if (!member) throw new NotFoundException('Archived member not found');

      await this.teamModel
        .updateOne(
          { _id: memOid, workspaceId: wsOid },
          { isDeleted: false, deletedAt: null, isActive: false },
        )
        .exec();

      this.auditTeamEvent({
        action: 'team.member_restored',
        workspaceId,
        actorId,
        memberId,
        actorNameSnapshot: member.name,
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.member_restored',
        properties: { workspaceId, memberId },
      });

      return {
        success: true,
        message: 'Team member restored as inactive',
        data: null,
      };
    });
  }

  /**
   * Phase 1f verify-later flow (2026-05-21). Owner skipped OTP at add-member
   * time and is now verifying the saved member's mobile from the member
   * profile page. Reuses the same OTP machinery (start / confirm endpoints
   * mint a JWT proof token bound to (workspaceId, mobile)); this method takes
   * that token, validates it against the persisted mobile of the member, and
   * stamps mobileVerifiedAt + mobileVerifiedBy.
   *
   * Why a dedicated method (not update()): update() rewrites arbitrary
   * profile fields and is gated by team-field-groups. mobileVerifyToken is
   * a system-level pass-through field that does not map to any group;
   * routing through here keeps the gating clean (single permission:
   * team.member.create) and skips the field-group classifier.
   */
  async verifyExistingMemberMobile(
    workspaceId: string,
    memberId: string,
    mobileVerifyToken: string,
    actorId: string,
  ) {
    return this.withTeamSpan(
      'team.verifyExistingMemberMobile',
      { workspaceId, memberId },
      async () => {
        // 2026-05-22: explicit ObjectId casts (same fix as remove / restore).
        const wsOid = new Types.ObjectId(workspaceId);
        const memOid = new Types.ObjectId(memberId);

        const member = await this.teamModel
          .findOne({ _id: memOid, workspaceId: wsOid, isDeleted: { $ne: true } })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');
        if (!member.mobile) {
          throw new BadRequestException(
            'This member does not have a mobile number on record. Add one before verifying.',
          );
        }

        await this.mobileOtpService.assertProofToken(workspaceId, member.mobile, mobileVerifyToken);

        const now = new Date();
        await this.teamModel
          .updateOne(
            { _id: memOid, workspaceId: wsOid },
            {
              $set: {
                mobileVerifiedAt: now,
                mobileVerifiedBy: new Types.ObjectId(actorId),
              },
            },
          )
          .exec();

        this.auditTeamEvent({
          action: 'team.member_mobile_verified',
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'team.member_mobile_verified',
          properties: {
            workspaceId,
            memberId,
            mobileLast4: member.mobile.slice(-4),
          },
        });

        const fresh = await this.teamModel.findById(memOid).exec();
        if (!fresh) throw new NotFoundException('Team member not found');
        return this.toResponse(fresh);
      },
    );
  }

  /**
   * Permanently delete an archived member (mark as permanently deleted instead of removing)
   */
  async removePermanent(workspaceId: string, memberId: string, actorId: string) {
    return this.withTeamSpan('team.removePermanent', { workspaceId, memberId }, async () => {
      // 2026-05-22: explicit ObjectId casts (same fix as remove / restore).
      const wsOid = new Types.ObjectId(workspaceId);
      const memOid = new Types.ObjectId(memberId);

      const member = await this.teamModel
        .findOne({
          _id: memOid,
          workspaceId: wsOid,
          isDeleted: true,
          isPermanentlyDeleted: { $ne: true },
        })
        .exec();
      if (!member) throw new NotFoundException('Archived member not found');

      // Remove-vs-Delete policy (DATA-MAP §1b): a hard permanent-delete is BLOCKED
      // when the member has salary/payroll/statutory history — those rows are
      // retained 8/10y and may only be destroyed by the system retention job, never
      // by a manual permanent-delete. memberHasHistory is the salary-side gate
      // (resolved lazily via moduleRef across the forwardRef cycle). Best-effort:
      // if the salary module is unavailable we fall through to the existing
      // soft-archive-only behaviour (no data is destroyed).
      try {
        const salaryLifecycle = this.moduleRef.get<SalaryLifecycleService>(SalaryLifecycleService, {
          strict: false,
        });
        if (salaryLifecycle && (await salaryLifecycle.memberHasHistory(workspaceId, memberId))) {
          throw new BadRequestException({
            code: 'MEMBER_HAS_HISTORY',
            message:
              'This member has payroll/salary history that must be retained by law. They stay archived (removed) and cannot be permanently deleted; the system purges retained records only after the statutory window.',
          });
        }
      } catch (err) {
        // Re-throw our own policy block; swallow only resolver/availability errors.
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(
          `memberHasHistory gate skipped (resolver error) ws=${workspaceId} member=${memberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }

      // Attendance hardening (OQ-A1) — the SAME Remove-vs-Delete gate, attendance
      // side: a member with any Attendance row or AttendanceEvent owns muster-roll
      // evidence (statutory under ESI / Gujarat LWF, retained 10y) and must NOT be
      // hard-deleted. This closes the gap where a no-salary, attendance-only member
      // could otherwise slip past the salary gate. Resolved lazily via moduleRef;
      // best-effort on resolver errors (no data is destroyed — we fall through to
      // the soft-archive-only behaviour).
      try {
        const attendanceLifecycle = this.moduleRef.get<AttendanceLifecycleService>(
          AttendanceLifecycleService,
          { strict: false },
        );
        if (
          attendanceLifecycle &&
          (await attendanceLifecycle.memberHasHistory(workspaceId, memberId))
        ) {
          throw new BadRequestException({
            code: 'MEMBER_HAS_HISTORY',
            message:
              'This member has attendance/muster history that must be retained by law. They stay archived (removed) and cannot be permanently deleted; the system purges retained records only after the statutory window.',
          });
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(
          `attendance memberHasHistory gate skipped (resolver error) ws=${workspaceId} member=${memberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }

      // Finance/Bills hardening (OQ-FB-1 → A) — the SAME Remove-vs-Delete gate,
      // finance side: a member with ANY Bill (incl. draft-only), posted
      // PurchaseBill, posted ExpenseVoucher, or LedgerEntry attributed to them
      // owns books-of-account records (Bucket B, retained 8y under Companies Act
      // s.128 / CGST Rule 56 / IT Act s.44AA) and must NOT be hard-deleted — the
      // books must stay complete. This closes the gap where a finance-only
      // member (entered/posted bills but no salary or attendance) could slip past
      // the salary + attendance gates. Resolved lazily via moduleRef; best-effort
      // on resolver errors (no data is destroyed — we fall through to the
      // soft-archive-only behaviour).
      try {
        const billsLifecycle = this.moduleRef.get<BillsLifecycleService>(BillsLifecycleService, {
          strict: false,
        });
        if (billsLifecycle && (await billsLifecycle.memberHasHistory(workspaceId, memberId))) {
          throw new BadRequestException({
            code: 'MEMBER_HAS_HISTORY',
            message:
              'This member has finance/bills history (bills, purchase bills, expenses, or ledger entries) that must be retained by law. They stay archived (removed) and cannot be permanently deleted; the system purges retained records only after the statutory window.',
          });
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(
          `finance/bills memberHasHistory gate skipped (resolver error) ws=${workspaceId} member=${memberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }

      // Retain the files for future recovery; only release their quota so the
      // deleted member stops counting against storage. Physical deletion is
      // deferred to the future admin purge. See MODULE-PLAYBOOK pattern 17.
      if (member.avatar) await this.uploadsService.releaseFileFromQuota(member.avatar, workspaceId);
      if (member.bankDetails?.passbookImageUrl)
        await this.uploadsService.releaseFileFromQuota(
          member.bankDetails.passbookImageUrl,
          workspaceId,
        );
      if (member.upiDetails?.qrCodeUrl)
        await this.uploadsService.releaseFileFromQuota(member.upiDetails.qrCodeUrl, workspaceId);

      // Mark as permanently deleted instead of removing from DB
      // IMPORTANT: Do NOT touch the User document in the auth collection. It belongs to the user.
      await this.teamModel
        .updateOne(
          { _id: memOid, workspaceId: wsOid },
          {
            $set: {
              isPermanentlyDeleted: true,
              permanentlyDeletedAt: new Date(),
            },
          },
        )
        .exec();

      this.auditTeamEvent({
        action: 'team.member_permanently_deleted',
        workspaceId,
        actorId,
        memberId,
        actorNameSnapshot: member.name,
      });

      return {
        success: true,
        message: 'Team member permanently deleted',
        data: null,
      };
    });
  }

  /**
   * Bulk update status (activate/deactivate)
   */
  async bulkUpdateStatus(
    workspaceId: string,
    memberIds: string[],
    status: 'active' | 'inactive',
    actorId: string,
  ) {
    return this.withTeamSpan('team.bulkUpdateStatus', { workspaceId }, async () => {
      // workspaceId must be cast: the schema's `Workspace | Types.ObjectId`
      // union suppresses Mongoose's implicit string->ObjectId cast, so a raw
      // string never matches the stored ObjectId and updateMany silently
      // modifies 0 docs. Mirrors the single restore()/remove() fix.
      const wsOid = new Types.ObjectId(workspaceId);
      const result = await this.teamModel
        .updateMany(
          {
            _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) },
            workspaceId: wsOid,
            isDeleted: { $ne: true },
          },
          {
            isActive: status === 'active',
            ...(status === 'inactive' ? { hasAppAccess: false } : {}),
          },
        )
        .exec();

      this.auditTeamEvent({
        action: 'team.bulk_status_changed',
        workspaceId,
        actorId,
        meta: { status, count: result.modifiedCount, memberIds },
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.bulk_action',
        properties: { workspaceId, action: 'status_changed', status, count: result.modifiedCount },
      });

      return { success: true, data: { updated: result.modifiedCount } };
    });
  }

  /**
   * Bulk archive (soft delete)
   */
  async bulkDelete(workspaceId: string, memberIds: string[], actorId: string) {
    return this.withTeamSpan('team.bulkDelete', { workspaceId }, async () => {
      // Soft delete only — does NOT delete S3 files
      // User documents are never touched
      // workspaceId cast required (see bulkUpdateStatus): the schema union type
      // suppresses Mongoose's implicit cast, so a raw string matches 0 docs.
      const wsOid = new Types.ObjectId(workspaceId);
      const result = await this.teamModel
        .updateMany(
          {
            _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) },
            workspaceId: wsOid,
            isDeleted: { $ne: true },
          },
          {
            isDeleted: true,
            deletedAt: new Date(),
            isActive: false,
            hasAppAccess: false,
            linkedUserId: null,
            appAccessInviteToken: null,
            appAccessInviteExpiry: null,
          },
        )
        .exec();

      this.auditTeamEvent({
        action: 'team.bulk_archived',
        workspaceId,
        actorId,
        meta: { count: result.modifiedCount, memberIds },
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.bulk_action',
        properties: { workspaceId, action: 'archived', count: result.modifiedCount },
      });

      return { success: true, data: { archived: result.modifiedCount } };
    });
  }

  /**
   * CSV bulk import — create many members in one request.
   *
   * Loops the single create() per row so every member reuses the exact same
   * validation, mobile/identifier classification, employee-code generation,
   * audit + PostHog hooks. Rows are processed sequentially (not Promise.all)
   * so employee-code auto-increment stays race-free and per-row errors map
   * cleanly back to their input index. Partial success is the norm: a bad row
   * is collected into `failed` and the rest still persist.
   *
   * Called by team.controller `bulk-create` (web import wizard). Returns a
   * per-row report the wizard renders as a success/failure summary.
   */
  async bulkCreate(workspaceId: string, userId: string, members: CreateTeamMemberDto[]) {
    return this.withTeamSpan(
      'team.bulkCreate',
      { workspaceId, userId, mode: 'csv_import' },
      async () => {
        const created: Array<{
          index: number;
          id: string;
          name: string;
          employeeCode: string | null;
        }> = [];
        const failed: Array<{ index: number; name: string; error: string }> = [];

        for (let i = 0; i < members.length; i++) {
          const row = members[i];
          try {
            const res: any = await this.create(workspaceId, userId, row);
            const member = res?.data?.member ?? {};
            created.push({
              index: i,
              id: (member.id ?? member._id ?? '').toString(),
              name: row.name,
              employeeCode: member.employeeCode ?? null,
            });
          } catch (e: any) {
            // Keep going — one malformed row should never abort the import.
            // BadRequest/Conflict messages (duplicate mobile, bad IFSC, etc.)
            // are surfaced verbatim so the owner can fix that row and re-upload.
            const message = e?.response?.message ?? e?.message ?? 'Could not create this member';
            failed.push({
              index: i,
              name: row?.name ?? `Row ${i + 1}`,
              error: Array.isArray(message) ? message.join('; ') : String(message),
            });
          }
        }

        this.auditTeamEvent({
          action: 'team.bulk_imported',
          workspaceId,
          actorId: userId,
          meta: { total: members.length, created: created.length, failed: failed.length },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'team.bulk_action',
          properties: {
            workspaceId,
            action: 'csv_imported',
            total: members.length,
            created: created.length,
            failed: failed.length,
          },
        });

        return {
          success: true,
          data: { total: members.length, created, failed },
        };
      },
    );
  }

  /**
   * Bulk restore archived members
   */
  async bulkRestore(workspaceId: string, memberIds: string[], actorId: string) {
    return this.withTeamSpan('team.bulkRestore', { workspaceId }, async () => {
      // workspaceId cast required (see bulkUpdateStatus): the schema union type
      // suppresses Mongoose's implicit cast, so a raw string matches 0 docs and
      // restore silently no-ops while still returning success.
      const wsOid = new Types.ObjectId(workspaceId);
      const result = await this.teamModel
        .updateMany(
          {
            _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) },
            workspaceId: wsOid,
            isDeleted: true,
          },
          { isDeleted: false, deletedAt: null, isActive: false },
        )
        .exec();

      this.auditTeamEvent({
        action: 'team.bulk_restored',
        workspaceId,
        actorId,
        meta: { count: result.modifiedCount, memberIds },
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.bulk_action',
        properties: { workspaceId, action: 'restored', count: result.modifiedCount },
      });

      return { success: true, data: { restored: result.modifiedCount } };
    });
  }

  /**
   * P1.8.1 (2026-05-14) — context-aware grant-flow prelude.
   *
   * Returns just enough for the Grant Access drawer to pick the right copy
   * + default channel before any mutation. Three buckets:
   *
   *   - 'none'           — no User matches the team-member's mobile/email.
   *                        Cold invite: SMS/email link delivery.
   *   - 'registered'     — a User matches and is not bound to a different
   *                        directory entry in this workspace. Granting will
   *                        notify them in-app instantly; SMS is optional.
   *   - 'conflict'       — a User matches BUT is already `linkedUserId` on
   *                        a different TeamMember in this workspace. Owner
   *                        must edit the contact or the other member first.
   *   - 'already_granted'— member already has app access or a pending
   *                        invite; the drawer should redirect to the
   *                        lifecycle UI instead of opening.
   *
   * Read-only — never mutates. Cheap enough to call on rail render.
   */
  async getGrantContext(workspaceId: string, memberId: string) {
    return this.withTeamSpan('team.getGrantContext', { workspaceId, memberId }, async () => {
      const member = await this.teamModel
        .findOne({
          _id: new Types.ObjectId(memberId),
          workspaceId: new Types.ObjectId(workspaceId),
        })
        .exec();
      if (!member) throw new NotFoundException('Team member not found');

      // P1.8-revert.14 (2026-05-14) — User lookup moved BEFORE the
      // already_granted short-circuit so the resend-modal warm/cold
      // detection on the FE side works for INVITED members too. Without
      // this, getGrantContext returned 'already_granted' without
      // matchedUser, and the FE's in-app channel was always disabled
      // even when the invitee clearly had a zari360 account.
      const usersModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
        strict: false,
      });
      const identifierClauses: Array<Record<string, unknown>> = [];
      if (member.mobile) identifierClauses.push({ mobile: member.mobile });
      if (member.email) identifierClauses.push({ email: member.email });
      const matchedUser = identifierClauses.length
        ? await usersModel.findOne({ $or: identifierClauses }).lean().exec()
        : null;

      const matchedUserShape = matchedUser
        ? {
            id: String(matchedUser._id),
            name: matchedUser.name as string,
            mobile: matchedUser.mobile as string | undefined,
            email: matchedUser.email as string | undefined,
          }
        : null;

      // Already-granted short-circuit. The drawer should not open in this
      // state; the rail's INVITED/ACTIVE branch owns the lifecycle UI.
      if (member.hasAppAccess || member.appAccessInviteToken) {
        return {
          inviteeStatus: 'already_granted' as const,
          matchedUser: matchedUserShape,
          customOverrides: member.permissionOverrides ?? [],
        };
      }

      // Resolve the canonical Member role id for this workspace so the
      // drawer can pre-select it without an extra round trip.
      const roleModel = this.moduleRef.get<Model<any>>(getModelToken('Role'), {
        strict: false,
      });
      const defaultRole = await roleModel
        .findOne({
          workspaceId: new Types.ObjectId(workspaceId),
          name: 'Member',
          isSystem: true,
        })
        .lean()
        .exec();

      if (!matchedUser) {
        return {
          inviteeStatus: 'none' as const,
          matchedUser: null,
          defaultRoleId: defaultRole?._id?.toString() ?? null,
          customOverrides: member.permissionOverrides ?? [],
        };
      }

      // Conflict detection — matched User is already bound to another
      // directory entry in THIS workspace. Owner must resolve the
      // collision before granting (typing the same number into two
      // members is a real data-entry mistake, not an edge case).
      const conflictingMember = await this.teamModel
        .findOne({
          workspaceId: new Types.ObjectId(workspaceId),
          linkedUserId: matchedUser._id,
          _id: { $ne: member._id },
        })
        .select('name employeeCode')
        .lean()
        .exec();

      return {
        inviteeStatus: conflictingMember ? 'conflict' : 'registered',
        matchedUser: {
          id: String(matchedUser._id),
          name: matchedUser.name as string,
          mobile: matchedUser.mobile as string | undefined,
          email: matchedUser.email as string | undefined,
        },
        ...(conflictingMember
          ? {
              conflictWith: {
                memberId: String(conflictingMember._id),
                name: conflictingMember.name,
                employeeCode: conflictingMember.employeeCode ?? null,
              },
            }
          : {}),
        defaultRoleId: defaultRole?._id?.toString() ?? null,
        customOverrides: member.permissionOverrides ?? [],
      };
    });
  }

  /**
   * Grant app access - set rbacRoleId, generate invite token
   */
  async grantAccess(
    workspaceId: string,
    memberId: string,
    grantorId: string,
    grantDto: GrantAccessDto,
  ) {
    return this.withTeamSpan(
      'team.grantAccess',
      { workspaceId, userId: grantorId, memberId },
      async () => {
        // ── DEPRECATED (Wave 2, 2026-05-10) ───────────────────────────────
        // Use POST /workspaces/:wsId/invite with teamMemberId set instead.
        // This endpoint stays callable for one release for backward-compat
        // with existing mobile + web clients. Behavior preserved 1:1; in
        // addition, a parallel WorkspaceMember row is dual-written so the
        // new POST /invites/:token/accept endpoint can resolve tokens
        // produced by either flow during the transition window.
        this.logger.warn(
          `team.grantAccess is deprecated (Wave 2 invite consolidation); ` +
            `use POST /workspaces/:wsId/invite with teamMemberId set. ` +
            `workspaceId=${workspaceId} memberId=${memberId}`,
        );

        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');

        // Check if already has app access
        if (member.hasAppAccess) {
          throw new HttpException(
            { success: false, message: 'Member already has app access' },
            HttpStatus.BAD_REQUEST,
          );
        }

        const rawToken = crypto.randomBytes(32).toString('hex');
        const inviteTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const inviteExpiry = new Date();
        inviteExpiry.setDate(inviteExpiry.getDate() + 7); // 7 days

        member.rbacRoleId = new Types.ObjectId(grantDto.rbacRoleId);
        member.appAccessInviteToken = rawToken;
        member.appAccessInviteTokenHash = inviteTokenHash;
        member.appAccessInviteExpiry = inviteExpiry;
        member.appAccessGrantedBy = new Types.ObjectId(grantorId);

        if (grantDto.email) {
          member.email = grantDto.email;
        }

        await member.save();

        // ── Wave 2 dual-write (2026-05-10) ────────────────────────────────
        // Mirror the token onto a WorkspaceMember row so POST
        // /invites/:token/accept resolves the same token regardless of
        // which flow generated it. Idempotent: if a linked invite already
        // exists (rare race with the new flow), update it in place.
        const workspaceMemberModel = this.moduleRef.get<Model<any>>(
          getModelToken('WorkspaceMember'),
          { strict: false },
        );
        const linkedTeamMemberId = new Types.ObjectId(memberId);
        const inviteIdentifier = grantDto.email || member.email || member.mobile || null;
        const inviteeType = grantDto.email || member.email ? 'email' : 'mobile';

        // Look up existing User by mobile/email so the bridge row links to
        // an account when one exists. Mirrors workspaces.inviteMember.
        const usersModelForLookup = this.moduleRef.get<Model<any>>(getModelToken('User'), {
          strict: false,
        });
        const linkedUser = inviteIdentifier
          ? await usersModelForLookup
              .findOne({ $or: [{ email: inviteIdentifier }, { mobile: inviteIdentifier }] })
              .exec()
          : null;

        // P1.7 (2026-05-14) — include 'removed' status in the upsert filter
        // so a re-grant after a prior revoke REACTIVATES the same row in
        // place rather than orphaning the removed row + inserting a fresh
        // one. Keeps audit history coherent and prevents future E11000
        // pairs on (workspaceId, linkedTeamMemberId) once that becomes a
        // unique constraint. `removedAt` / `removedBy` are explicitly
        // $unset on reactivation so the reactivated row reads as clean.
        const wsMemberDoc = await workspaceMemberModel
          .findOneAndUpdate(
            {
              workspaceId: new Types.ObjectId(workspaceId),
              linkedTeamMemberId,
              status: { $in: ['invited', 'active', 'removed', 'declined'] },
            },
            {
              $set: {
                workspaceId: new Types.ObjectId(workspaceId),
                userId: linkedUser ? new Types.ObjectId(linkedUser._id) : null,
                roleId: new Types.ObjectId(grantDto.rbacRoleId),
                status: 'invited',
                invitedBy: new Types.ObjectId(grantorId),
                inviteTokenHash,
                inviteExpiry,
                inviteeIdentifier: inviteIdentifier ?? undefined,
                inviteeType,
                linkedTeamMemberId,
              },
              $unset: {
                removedAt: '',
                removedBy: '',
                joinedAt: '',
              },
            },
            { upsert: true, new: true },
          )
          .exec();

        member.linkedWorkspaceMemberId = wsMemberDoc?._id ?? null;
        await member.save();

        // Get workspace and role info for notification
        const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
          strict: false,
        });
        const workspace = await workspaceModel.findById(workspaceId).exec();
        const workspaceName = workspace?.name || 'a workspace';

        // Get role name
        const roleModel = this.moduleRef.get<Model<any>>(getModelToken('Role'), {
          strict: false,
        });
        const role = await roleModel.findById(grantDto.rbacRoleId).exec();
        const roleName = role?.name || 'Team Member';

        // Send notifications based on sendMethod
        let message = 'Access granted. ';

        if (grantDto.sendMethod === 'auto' || grantDto.sendMethod === 'both') {
          const inviteUrl = `${this.webAppUrl}/invite?token=${rawToken}&type=team`;
          const mobileDeepLink = `${this.mobileDeepLink}/${rawToken}`;

          // Get grantor name
          const usersModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
            strict: false,
          });
          const grantor = await usersModel.findById(grantorId).exec();
          const grantorName = grantor?.name || 'Someone';

          // Send email if provided
          if (grantDto.email) {
            // Wave-3 Drift #32 — universal email-quota enforcement.
            const quota = await this.mailService.checkEmailQuota(workspaceId);
            if (!quota.allowed) {
              this.logger.warn(
                `grantAccess email skipped to=${grantDto.email} reason=${quota.reason}`,
              );
            } else {
              try {
                await this.mailService.sendTeamAccessInvitationEmail(grantDto.email, {
                  memberName: member.name,
                  workspaceName,
                  appRole: roleName,
                  inviteUrl,
                  mobileDeepLink,
                  expiryDays: 7,
                });
                await this.mailService.incrementEmailUsage(workspaceId);
              } catch (e) {
                this.logger.error(
                  `grantAccess email failed: ${(e as Error)?.message ?? e}`,
                  (e as Error)?.stack,
                );
                Sentry.captureException(e, {
                  tags: { module: 'team', op: 'grantAccess.email' },
                  extra: { workspaceId, memberId },
                });
              }
            }
          }

          // Send SMS if member has mobile
          if (member.mobile) {
            const smsMessage = `You've been granted app access to ${workspaceName}. Accept here: ${inviteUrl}`;
            try {
              await this.smsService.send(member.mobile, smsMessage);
            } catch (e) {
              this.logger.error(
                `grantAccess SMS failed: ${(e as Error)?.message ?? e}`,
                (e as Error)?.stack,
              );
              Sentry.captureException(e, {
                tags: { module: 'team', op: 'grantAccess.sms' },
                extra: { workspaceId, memberId },
              });
            }
          }

          message += 'Invitation sent. ';
        }

        this.auditTeamEvent({
          action: 'team.access_granted',
          workspaceId,
          actorId: grantorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: {
            sendMethod: grantDto.sendMethod,
            rbacRoleId: grantDto.rbacRoleId,
            emailProvided: !!grantDto.email,
          },
        });

        this.postHog.capture({
          distinctId: grantorId,
          event: 'team.access_granted',
          properties: {
            workspaceId,
            memberId,
            sendMethod: grantDto.sendMethod,
            emailProvided: !!grantDto.email,
          },
        });

        return {
          success: true,
          data: {
            message,
            inviteToken:
              grantDto.sendMethod === 'link' || grantDto.sendMethod === 'both'
                ? rawToken
                : undefined,
          },
        };
      },
    );
  }

  // ── App Access Management (P1+P2+P3) ──────────────────────────────────────
  //
  // The four endpoints below pair with /grant-access to form the full app-
  // access lifecycle. They share three rules:
  //
  //   1. Per-workspace scoping via the (workspaceId, memberId) tuple.
  //   2. Dual-write to WorkspaceMember so RolesGuard sees a consistent state.
  //   3. Audit event + PostHog mirror on every successful mutation.

  /**
   * Send the invite notifications for an (already persisted) invite token.
   * Extracted so resendInvite can reuse the exact same email + SMS code path
   * grantAccess uses. Kept private to avoid widening the public surface.
   *
   * Errors are logged + Sentry-tagged; never thrown — a failed email must
   * not roll back the underlying invite mutation.
   */
  private async sendAccessInviteNotifications(params: {
    workspaceId: string;
    memberName: string;
    memberMobile?: string;
    rawToken: string;
    sendMethod: 'auto' | 'link' | 'both';
    emailOverride?: string;
    storedEmail?: string;
    grantorId: string;
    rbacRoleId: string;
    /**
     * P1.8-revert.13 (2026-05-14) — explicit channel allowlist. When set,
     * overrides the legacy sendMethod derivation. An empty array means
     * "rotate token but dispatch nothing" — share panel still works.
     */
    channels?: ('email' | 'sms' | 'in_app')[];
  }): Promise<void> {
    // Derive per-channel flags. Channels array takes precedence; falls
    // back to sendMethod for legacy callers.
    const useChannels = params.channels !== undefined;
    const fireEmail = useChannels
      ? params.channels.includes('email')
      : params.sendMethod === 'auto' || params.sendMethod === 'both';
    const fireSms = useChannels
      ? params.channels.includes('sms')
      : params.sendMethod === 'auto' || params.sendMethod === 'both';
    const fireInApp = useChannels ? params.channels.includes('in_app') : false;
    if (!fireEmail && !fireSms && !fireInApp) return;

    const inviteUrl = `${this.webAppUrl}/invite?token=${params.rawToken}&type=team`;
    const mobileDeepLink = `${this.mobileDeepLink}/${params.rawToken}`;

    const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
      strict: false,
    });
    const workspace = await workspaceModel.findById(params.workspaceId).exec();
    const workspaceName = workspace?.name || 'a workspace';

    const roleModel = this.moduleRef.get<Model<any>>(getModelToken('Role'), {
      strict: false,
    });
    const role = await roleModel.findById(params.rbacRoleId).exec();
    const roleName = role?.name || 'Team Member';

    const email = params.emailOverride || params.storedEmail;
    if (fireEmail && email) {
      const quota = await this.mailService.checkEmailQuota(params.workspaceId);
      if (!quota.allowed) {
        this.logger.warn(`resendInvite email skipped to=${email} reason=${quota.reason}`);
      } else {
        try {
          await this.mailService.sendTeamAccessInvitationEmail(email, {
            memberName: params.memberName,
            workspaceName,
            appRole: roleName,
            inviteUrl,
            mobileDeepLink,
            expiryDays: 7,
          });
          await this.mailService.incrementEmailUsage(params.workspaceId);
        } catch (e) {
          this.logger.error(
            `resendInvite email failed: ${(e as Error)?.message ?? e}`,
            (e as Error)?.stack,
          );
          Sentry.captureException(e, {
            tags: { module: 'team', op: 'resendInvite.email' },
            extra: { workspaceId: params.workspaceId },
          });
        }
      }
    }

    if (fireSms && params.memberMobile) {
      const smsMessage = `You've been granted app access to ${workspaceName}. Accept here: ${inviteUrl}`;
      try {
        await this.smsService.send(params.memberMobile, smsMessage);
      } catch (e) {
        this.logger.error(
          `resendInvite SMS failed: ${(e as Error)?.message ?? e}`,
          (e as Error)?.stack,
        );
        Sentry.captureException(e, {
          tags: { module: 'team', op: 'resendInvite.sms' },
          extra: { workspaceId: params.workspaceId },
        });
      }
    }

    // P1.8-revert.13 (2026-05-14) — in-app notification fan-out for warm
    // invitees. Looks up the User row by mobile or email via the User
    // model; silently no-ops if the invitee is cold (no User account
    // exists yet). NotificationsService access uses the same moduleRef
    // lookup pattern other team-service helpers in this file rely on.
    if (fireInApp) {
      try {
        const userModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
          strict: false,
        });
        const orClauses: any[] = [];
        if (params.memberMobile) orClauses.push({ mobile: params.memberMobile });
        if (email) orClauses.push({ email });
        const matchedUser = orClauses.length
          ? await userModel.findOne({ $or: orClauses }).exec()
          : null;
        if (matchedUser?._id) {
          const notificationsService = this.moduleRef.get<{
            createNotification: (workspaceId: string, dto: any) => Promise<any>;
          }>('NotificationsService', { strict: false });
          await notificationsService.createNotification(params.workspaceId, {
            recipientId: String(matchedUser._id),
            type: 'info',
            title: 'Workspace Invitation',
            message: `You've been invited to join ${workspaceName} as ${roleName}.`,
            metadata: {
              category: 'INVITE_RECEIVED',
              workspaceId: params.workspaceId,
              workspaceName,
              role: roleName,
              inviteUrl,
            },
          });
        }
      } catch (e) {
        this.logger.error(`resendInvite in-app notification failed: ${(e as Error)?.message ?? e}`);
        Sentry.captureException(e, {
          tags: { module: 'team', op: 'resendInvite.in_app' },
          extra: { workspaceId: params.workspaceId },
        });
      }
    }
  }

  /**
   * Hard revoke app access for a team member.
   *
   * Clears all access fields on TeamMember, flips the linked WorkspaceMember
   * row to status='removed', adds the linked user to the Redis revocation
   * denylist, and deactivates Sessions matching (userId, workspaceId). Other
   * workspaces the same user belongs to are unaffected — only sessions
   * carrying THIS workspaceId are killed.
   *
   * `dto.hardRevoke === false` keeps the directory-side cleanup but skips
   * the denylist + session-kill; intended for future "pause access" semantics
   * (P4). Today the controller always sends the default (hard).
   */
  async revokeAccess(workspaceId: string, memberId: string, actorId: string, dto: RevokeAccessDto) {
    return this.withTeamSpan(
      'team.revokeAccess',
      { workspaceId, userId: actorId, memberId },
      async () => {
        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');

        const linkedUserId = member.linkedUserId
          ? new Types.ObjectId(String(member.linkedUserId))
          : null;
        const hardRevoke = dto.hardRevoke !== false;

        await this.teamModel.updateOne(
          { _id: member._id },
          {
            $set: { hasAppAccess: false },
            $unset: {
              linkedUserId: '',
              linkedWorkspaceMemberId: '',
              appAccessInviteToken: '',
              appAccessInviteTokenHash: '',
              appAccessInviteExpiry: '',
              appAccessGrantedBy: '',
              appAccessGrantedAt: '',
            },
          },
        );

        const workspaceMemberModel = this.moduleRef.get<Model<any>>(
          getModelToken('WorkspaceMember'),
          { strict: false },
        );
        await workspaceMemberModel
          .updateMany(
            {
              workspaceId: new Types.ObjectId(workspaceId),
              linkedTeamMemberId: new Types.ObjectId(memberId),
              status: { $in: ['active', 'invited'] },
            },
            {
              $set: {
                status: 'removed',
                removedAt: new Date(),
                removedBy: new Types.ObjectId(actorId),
              },
            },
          )
          .exec();

        if (hardRevoke && linkedUserId) {
          await this.revocationService.revoke(workspaceId, linkedUserId.toString());

          const sessionModel = this.moduleRef.get<Model<any>>(getModelToken('Session'), {
            strict: false,
          });
          await sessionModel
            .updateMany(
              {
                userId: linkedUserId,
                workspaceId: new Types.ObjectId(workspaceId),
                isActive: true,
              },
              { $set: { isActive: false } },
            )
            .exec();
        }

        this.auditTeamEvent({
          action: 'team.access_revoked',
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: {
            reason: dto.reason,
            hardRevoke,
            linkedUserId: linkedUserId?.toString(),
          },
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'team.access_revoked',
          properties: { workspaceId, memberId, hardRevoke },
        });

        // P2.6 (2026-05-15) — notify the affected user that their app
        // access was revoked. Captured `linkedUserId` above before the
        // $unset cleared it from the doc. Fire-and-forget — notification
        // failure must not roll back the revoke (security primary, UX
        // secondary).
        if (linkedUserId) {
          try {
            const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
              strict: false,
            });
            const ws = await workspaceModel.findById(workspaceId).lean().exec();
            const workspaceName = (ws as { name?: string } | null)?.name ?? 'a workspace';
            await this.notificationsService.createNotification(workspaceId, {
              recipientId: String(linkedUserId),
              type: 'warning',
              title: 'App access revoked',
              message: `Your access to ${workspaceName} has been revoked.`,
              metadata: {
                category: 'ACCESS_REVOKED',
                workspaceId,
                teamMemberId: memberId,
              },
            });
          } catch (e) {
            this.logger.error(`revoke notification fan-out failed: ${(e as Error)?.message ?? e}`);
          }
        }

        const refreshed = await this.teamModel
          .findById(memberId)
          .populate(ROLE_POPULATE)
          .populate(SHIFT_POPULATE)
          .populate(GRANTED_BY_POPULATE)
          .exec();
        return { success: true, member: refreshed ? this.toResponse(refreshed) : null };
      },
    );
  }

  /**
   * Resend the invite to a member that already has a pending (or expired)
   * grant. Reuses the existing raw token when it is still within the 7-day
   * expiry window; otherwise (or when `dto.forceRegenerate === true`)
   * rotates the token and writes a fresh hash + expiry.
   *
   * Refuses to run for ACTIVE members — those need either changeAccessRole
   * (still active) or revokeAccess → grantAccess (rotate identity).
   */
  async resendInvite(workspaceId: string, memberId: string, actorId: string, dto: ResendInviteDto) {
    return this.withTeamSpan(
      'team.resendInvite',
      { workspaceId, userId: actorId, memberId },
      async () => {
        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');

        if (member.hasAppAccess) {
          throw new HttpException(
            {
              success: false,
              message: 'Member already has access; revoke first or change role instead',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (!member.rbacRoleId) {
          throw new HttpException(
            { success: false, message: 'No app-access role assigned; grant access first' },
            HttpStatus.BAD_REQUEST,
          );
        }

        const now = new Date();
        const hasValidToken =
          !!member.appAccessInviteToken &&
          !!member.appAccessInviteExpiry &&
          new Date(member.appAccessInviteExpiry) > now;
        const shouldReuse = hasValidToken && !dto.forceRegenerate;

        let rawToken: string;
        let inviteTokenHash: string;
        let inviteExpiry: Date;

        if (shouldReuse) {
          rawToken = member.appAccessInviteToken;
          inviteTokenHash = member.appAccessInviteTokenHash;
          inviteExpiry = new Date(member.appAccessInviteExpiry);
        } else {
          rawToken = crypto.randomBytes(32).toString('hex');
          inviteTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          inviteExpiry = new Date();
          inviteExpiry.setDate(inviteExpiry.getDate() + 7);

          member.appAccessInviteToken = rawToken;
          member.appAccessInviteTokenHash = inviteTokenHash;
          member.appAccessInviteExpiry = inviteExpiry;
          await member.save();

          // Mirror the new token onto the bridge WorkspaceMember row so the
          // /invites/:token/accept endpoint resolves the regenerated token.
          const workspaceMemberModel = this.moduleRef.get<Model<any>>(
            getModelToken('WorkspaceMember'),
            { strict: false },
          );
          await workspaceMemberModel
            .updateMany(
              {
                workspaceId: new Types.ObjectId(workspaceId),
                linkedTeamMemberId: new Types.ObjectId(memberId),
                status: 'invited',
              },
              { $set: { inviteTokenHash, inviteExpiry } },
            )
            .exec();
        }

        await this.sendAccessInviteNotifications({
          workspaceId,
          memberName: member.name,
          memberMobile: member.mobile,
          rawToken,
          sendMethod: dto.sendMethod,
          emailOverride: dto.email,
          storedEmail: member.email,
          grantorId: actorId,
          rbacRoleId: String(member.rbacRoleId),
          channels: dto.channels,
        });

        this.auditTeamEvent({
          action: 'team.invite_resent',
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: {
            sendMethod: dto.sendMethod,
            regenerated: !shouldReuse,
            emailProvided: !!dto.email,
          },
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'team.invite_resent',
          properties: {
            workspaceId,
            memberId,
            sendMethod: dto.sendMethod,
            regenerated: !shouldReuse,
          },
        });

        return {
          success: true,
          data: {
            message: shouldReuse ? 'Invitation resent.' : 'Invitation regenerated and sent.',
            // P1.8-revert.13 (2026-05-14) — always return the raw token so
            // the FE share panel can re-render with the rotated URL. Owner
            // already has full grant power; surfacing the token they just
            // rotated carries no incremental risk.
            inviteToken: rawToken,
          },
        };
      },
    );
  }

  /**
   * Change the assigned RBAC role for a member with existing or pending
   * app access. Updates TeamMember.rbacRoleId AND the linked WorkspaceMember
   * row's roleId so RolesGuard's role lookup picks up the new role on the
   * next request. Also revokes any cached role on the Redis denylist so a
   * stale in-flight session is forced to re-resolve permissions.
   */
  async changeAccessRole(
    workspaceId: string,
    memberId: string,
    actorId: string,
    dto: ChangeAccessRoleDto,
  ) {
    return this.withTeamSpan(
      'team.changeAccessRole',
      { workspaceId, userId: actorId, memberId },
      async () => {
        // §7 Part B — a non-owner cannot change their own role (self-escalation).
        await this.assertNotSelfPrivilegeEdit(workspaceId, actorId, memberId);
        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');

        const hasPendingInvite =
          !!member.appAccessInviteTokenHash &&
          !!member.appAccessInviteExpiry &&
          new Date(member.appAccessInviteExpiry) > new Date();
        if (!member.hasAppAccess && !hasPendingInvite) {
          throw new HttpException(
            { success: false, message: 'No active access to change role on' },
            HttpStatus.BAD_REQUEST,
          );
        }

        const oldRoleId = member.rbacRoleId ? String(member.rbacRoleId) : null;
        const newRoleId = new Types.ObjectId(dto.rbacRoleId);

        member.rbacRoleId = newRoleId;
        await member.save();

        const workspaceMemberModel = this.moduleRef.get<Model<any>>(
          getModelToken('WorkspaceMember'),
          { strict: false },
        );
        await workspaceMemberModel
          .updateMany(
            {
              workspaceId: new Types.ObjectId(workspaceId),
              linkedTeamMemberId: new Types.ObjectId(memberId),
              status: { $in: ['active', 'invited'] },
            },
            { $set: { roleId: newRoleId } },
          )
          .exec();

        // 2026-05-22 fix: a role change is NOT a revocation; the member stays
        // active and must immediately resolve to the NEW role. RolesGuard reads
        // membership + role + overrides fresh on every request, so the new role
        // (written to WorkspaceMember.roleId above) applies on the member's very
        // next request with no extra signal. The previous `revoke(..., 5*60)`
        // instead made RolesGuard 403 ("access revoked") for the whole 5-minute
        // TTL, locking the still-active member out of every data route after a
        // role change (a role downgrade/upgrade looked like a total access loss).
        // CLEAR any stale deny entry so an active member is never wrongly denied
        // after a role change. (Hard removal still uses revoke(); see remove().)
        if (member.linkedUserId) {
          await this.revocationService.clear(workspaceId, String(member.linkedUserId));
          // Real-time push (SSE) so the member's web client re-fetches
          // /me/permissions instantly after the role change.
          this.permissionEvents.emit({
            userId: String(member.linkedUserId),
            workspaceId,
            changeKind: 'role_changed',
          });
        }

        // Phase 2.2 — dispatch role-change notification via multi-channel
        // dispatcher. Gate on hasAppAccess + linkedUserId only — a pending-
        // invite member (hasPendingInvite) does not have a user account yet
        // so there is nowhere to send a notification.
        //
        // I2: look up actor name + role names so the notification body uses
        //     human-readable strings rather than raw ObjectId hex.
        // I3: await the dispatch and capture the result for audit meta (mirrors
        //     the setPermissionOverrides pattern — fire-and-forget dropped).
        let notificationsDispatched = { inApp: false, email: false, sms: false };
        if (member.hasAppAccess && member.linkedUserId) {
          // Best-effort lookups — if either throws we still proceed; actorName
          // and role names simply fall back to their defaults inside the dispatcher.
          let actorName: string | undefined;
          let diffSummary: string;
          try {
            const userModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
              strict: false,
            });
            const roleModel = this.moduleRef.get<Model<any>>(getModelToken('Role'), {
              strict: false,
            });
            const [actor, oldRole, newRole] = await Promise.all([
              userModel.findById(actorId).select('name').lean(),
              oldRoleId
                ? roleModel.findById(oldRoleId).select('name').lean()
                : Promise.resolve(null),
              roleModel.findById(newRoleId).select('name').lean(),
            ]);
            actorName = (actor as { name?: string } | null)?.name;
            const oldRoleName = (oldRole as { name?: string } | null)?.name ?? 'previous role';
            const newRoleName = (newRole as { name?: string } | null)?.name ?? 'new role';
            diffSummary = oldRoleId
              ? `role changed from "${oldRoleName}" to "${newRoleName}"`
              : `role assigned: "${newRoleName}"`;
          } catch {
            diffSummary = oldRoleId
              ? `role changed from ${oldRoleId} to ${newRoleId.toString()}`
              : `role assigned: ${newRoleId.toString()}`;
          }

          try {
            notificationsDispatched = await this.permissionDispatcher.dispatch({
              workspaceId,
              recipientUserId: String(member.linkedUserId),
              recipientEmail: member.email,
              recipientMobile: member.mobile,
              affectedMemberName: member.name,
              affectedMemberId: memberId,
              actorName,
              changeKind: 'role_changed',
              diffSummary,
            });
          } catch (e) {
            this.logger.error(
              `PermissionDispatcher role-change fan-out failed for member ${memberId}: ${(e as Error).message}`,
            );
          }
        }

        this.auditTeamEvent({
          action: 'team.access_role_changed',
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: { oldRoleId, newRoleId: newRoleId.toString(), notificationsDispatched },
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'team.access_role_changed',
          properties: { workspaceId, memberId, oldRoleId, newRoleId: newRoleId.toString() },
        });

        const refreshed = await this.teamModel
          .findById(memberId)
          .populate(ROLE_POPULATE)
          .populate(SHIFT_POPULATE)
          .populate(GRANTED_BY_POPULATE)
          .exec();
        return { success: true, member: refreshed ? this.toResponse(refreshed) : null };
      },
    );
  }

  /**
   * Replace the per-member permission-override array. The override list
   * fully replaces the previous one (PUT semantics — send an empty array
   * to clear). RolesGuard merges these on top of the role's permissions
   * via `applyPermissionOverrides`: deny-override beats role-allow,
   * allow-override extends the role.
   */
  async setPermissionOverrides(
    workspaceId: string,
    memberId: string,
    actorId: string,
    dto: SetPermissionOverridesDto,
  ) {
    return this.withTeamSpan(
      'team.setPermissionOverrides',
      { workspaceId, userId: actorId, memberId },
      async () => {
        // §7 Part B — a non-owner cannot edit their own permission overrides
        // (self-escalation). Always owner-only, regardless of selfProfileEdit.
        await this.assertNotSelfPrivilegeEdit(workspaceId, actorId, memberId);
        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .exec();
        if (!member) throw new NotFoundException('Team member not found');

        // Enum-shape validation already done by the DTO; defensive check on
        // ModuleAction here keeps the contract honest if the DTO is ever
        // bypassed (e.g. a future internal service call).
        const validActions = new Set<string>(Object.values(ModuleAction));
        for (const ov of dto.overrides) {
          if (!validActions.has(ov.action)) {
            throw new HttpException(
              { success: false, message: `Unknown action: ${ov.action}` },
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        const prevCount = member.permissionOverrides?.length ?? 0;
        member.permissionOverrides = dto.overrides.map((ov) => ({
          module: ov.module,
          action: ov.action,
          allowed: ov.allowed,
          scope: ov.scope,
        }));

        // Phase 1d — invariants on the EFFECTIVE merged grant set (role +
        // overrides). A non-empty allow-override of `edit` without `view` would
        // be persisted then immediately reject reads; validate up front.
        const roleForMember = member.rbacRoleId
          ? await this.moduleRef
              .get<Model<any>>(getModelToken('Role'), { strict: false })
              .findById(member.rbacRoleId)
              .lean()
              .exec()
          : null;
        const rolePaths: GrantedPermission[] =
          (roleForMember as { permissionPaths?: GrantedPermission[] } | null)?.permissionPaths ??
          [];
        const effectivePaths = applyPathOverrides(rolePaths, dto.pathOverrides ?? []);
        assertViewEditCoherent(effectivePaths);
        assertDepsResolved(effectivePaths);

        // Phase 1c — path-based overrides for path-classified modules
        // (Team). PUT semantics: a payload without `pathOverrides` clears
        // them; the matrix always sends the full array.
        // Phase 1d — capture BEFORE state for audit diff (only allow-overrides
        // contribute to the granted set; deny-overrides are a separate axis).
        const prevPathOverrides: GrantedPermission[] = (member.permissionPathOverrides ?? [])
          .filter((o) => o.allowed)
          .map((o) => ({ path: o.path, scope: o.scope }));

        member.permissionPathOverrides = (dto.pathOverrides ?? []).map((o) => ({
          path: o.path,
          allowed: o.allowed,
          scope: o.scope,
        }));

        const nextPathOverrides: GrantedPermission[] = (dto.pathOverrides ?? [])
          .filter((o) => o.allowed)
          .map((o) => ({ path: o.path, scope: o.scope }));
        const pathDiff = diffGrants(prevPathOverrides, nextPathOverrides);

        await member.save();

        // 2026-05-22 fix: a permission-override change is NOT a revocation;
        // the member stays active and must immediately gain/lose exactly the
        // edited grants. RolesGuard re-resolves role + overrides fresh from the
        // DB on every request (no server-side cache), so the new overrides
        // apply on the member's very next request with no extra signal needed.
        //
        // The previous `revoke(..., 5*60)` was actively harmful: the revocation
        // denylist makes RolesGuard short-circuit with 403 ("access revoked")
        // for the ENTIRE TTL, so for 5 minutes after every edit the still-
        // active member was locked out of every permission-gated data route
        // (team list, attendance, etc.). Editing then immediately testing kept
        // resetting that window, so the change appeared to "never apply".
        // `/me/permissions` has no RolesGuard so it returned the new grants
        // (UI looked enabled) while the data calls 403'd: the exact "permission
        // change not reflected" report. We instead CLEAR any stale deny entry so
        // an active member is never wrongly denied after a perms edit.
        if (member.linkedUserId) {
          await this.revocationService.clear(workspaceId, String(member.linkedUserId));
          // Real-time push (SSE) so the member's web client re-fetches
          // /me/permissions instantly, instead of waiting up to 60s for the
          // notification poll. Fire-and-forget; never blocks the save.
          this.permissionEvents.emit({
            userId: String(member.linkedUserId),
            workspaceId,
            changeKind: 'overrides_updated',
          });
        }

        // Phase 2.2 — dispatch permission-change notification via multi-channel
        // dispatcher. Gate on hasAppAccess + linkedUserId (no point notifying
        // a member who has no app account). Each channel is try/caught inside
        // the dispatcher; the outer try/catch here guards against unexpected
        // top-level dispatcher errors — dispatch failure MUST NOT fail the save.
        //
        // I2: look up actor name for the notification body.
        let notificationsDispatched = { inApp: false, email: false, sms: false };
        if (member.hasAppAccess && member.linkedUserId) {
          // Best-effort actor name lookup — fall back to dispatcher default ("An admin")
          // if the User record is unavailable.
          let actorName: string | undefined;
          try {
            const userModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
              strict: false,
            });
            const actor = await userModel.findById(actorId).select('name').lean();
            actorName = (actor as { name?: string } | null)?.name;
          } catch {
            // non-fatal — actorName stays undefined and dispatcher defaults to "An admin"
          }

          try {
            notificationsDispatched = await this.permissionDispatcher.dispatch({
              workspaceId,
              recipientUserId: String(member.linkedUserId),
              recipientEmail: member.email,
              recipientMobile: member.mobile,
              affectedMemberName: member.name,
              affectedMemberId: memberId,
              actorName,
              changeKind: 'overrides_updated',
              diffSummary: this.formatPathDiffSummary(pathDiff),
            });
          } catch (e) {
            this.logger.error(
              `PermissionDispatcher unexpected error for member ${memberId}: ${(e as Error).message}`,
            );
          }
        }

        this.auditTeamEvent({
          action: 'team.permission_overrides_updated',
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: {
            prevCount,
            nextCount: dto.overrides.length,
            pathOverrideCount: member.permissionPathOverrides.length,
            pathDiff, // Phase 1d
            notificationsDispatched, // Phase 2.2
          },
        });

        this.postHog.capture({
          distinctId: actorId,
          event: 'team.permission_overrides_updated',
          properties: {
            workspaceId,
            memberId,
            prevCount,
            nextCount: dto.overrides.length,
            pathOverrideCount: member.permissionPathOverrides.length,
          },
        });

        const refreshed = await this.teamModel
          .findById(memberId)
          .populate(ROLE_POPULATE)
          .populate(SHIFT_POPULATE)
          .populate(GRANTED_BY_POPULATE)
          .exec();
        return { success: true, member: refreshed ? this.toResponse(refreshed) : null };
      },
    );
  }

  /**
   * Import members from another workspace the same user owns
   */
  async importMembers(workspaceId: string, importDto: ImportMembersDto, userId: string) {
    return this.withTeamSpan('team.importMembers', { workspaceId, userId }, async () => {
      const { sourceWorkspaceId, memberIds, rbacRoleId } = importDto;

      // Verify user has access to source workspace (owner check)
      try {
        const workspaceModel = this.moduleRef.get<Model<{ ownerId?: Types.ObjectId }>>(
          getModelToken('Workspace'),
          { strict: false },
        );
        const sourceWorkspace = await workspaceModel.findById(sourceWorkspaceId).exec();
        if (!isWorkspaceOwner(sourceWorkspace, userId)) {
          throw new HttpException(
            { success: false, message: 'You do not own the source workspace' },
            HttpStatus.FORBIDDEN,
          );
        }
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn(
          `importMembers ownership verify failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Fetch source members
      const sourceMembers = await this.teamModel
        .find({
          _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) },
          workspaceId: sourceWorkspaceId,
          isActive: true,
        })
        .exec();

      // Duplicate into the target workspace
      const imported: ReturnType<typeof this.toResponse>[] = [];
      for (const src of sourceMembers) {
        const srcObj = src.toObject() as Partial<TeamMemberDoc> & {
          __v?: unknown;
          updatedAt?: unknown;
        };
        delete srcObj._id;
        delete srcObj.__v;
        delete srcObj.createdAt;
        delete srcObj.updatedAt;

        // Phase 1f.1 — carry over mobile verification status when the source
        // member's number is verified AND is unchanged in the new workspace.
        // A different mobile (impossible here since we copy it verbatim) or a
        // missing mobileVerifiedAt means the imported row starts unverified.
        const srcMobileVerifiedAt =
          (srcObj as Record<string, unknown>).mobileVerifiedAt instanceof Date &&
          (srcObj as Record<string, unknown>).mobile === srcObj.mobile
            ? (srcObj as Record<string, unknown>).mobileVerifiedAt
            : null;
        const srcMobileVerifiedBy = srcMobileVerifiedAt
          ? ((srcObj as Record<string, unknown>).mobileVerifiedBy ?? null)
          : null;

        const newMember = new this.teamModel({
          ...srcObj,
          workspaceId,
          rbacRoleId: new Types.ObjectId(rbacRoleId),
          createdBy: new Types.ObjectId(userId),
          hasAppAccess: false,
          linkedUserId: undefined,
          appAccessInviteToken: undefined,
          appAccessInviteExpiry: undefined,
          appAccessGrantedAt: undefined,
          appAccessGrantedBy: undefined,
          isActive: true,
          mobileVerifiedAt: srcMobileVerifiedAt ?? null,
          mobileVerifiedBy: srcMobileVerifiedBy ?? null,
        });
        const saved = await newMember.save();

        imported.push(this.toResponse(saved));
      }

      this.auditTeamEvent({
        action: 'team.import_completed',
        workspaceId,
        actorId: userId,
        meta: {
          sourceWorkspaceId,
          count: imported.length,
          requestedCount: memberIds.length,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'team.import_completed',
        properties: {
          workspaceId,
          sourceWorkspaceId,
          count: imported.length,
          requestedCount: memberIds.length,
        },
      });

      return {
        success: true,
        data: { members: imported },
      };
    });
  }

  /**
   * Accept app access invite - link TeamMember to User account
   */
  async acceptInvite(token: string, userId: string) {
    return this.withTeamSpan('team.acceptInvite', { userId }, async () => {
      const member = await this.teamModel.findOne({ appAccessInviteToken: token }).exec();
      if (!member) {
        throw new NotFoundException('Invalid or expired invite token');
      }

      if (member.appAccessInviteExpiry && new Date(member.appAccessInviteExpiry) < new Date()) {
        throw new HttpException(
          { success: false, message: 'Invite token has expired' },
          HttpStatus.GONE,
        );
      }

      member.hasAppAccess = true;
      member.linkedUserId = new Types.ObjectId(userId);
      member.appAccessGrantedAt = new Date();
      member.appAccessInviteToken = undefined;
      member.appAccessInviteExpiry = undefined;

      await member.save();

      this.auditTeamEvent({
        action: 'team.invite_accepted',
        workspaceId: member.workspaceId,
        actorId: userId,
        memberId: member._id,
        actorNameSnapshot: member.name,
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'team.invite_accepted',
        properties: {
          workspaceId: String(member.workspaceId),
          memberId: member._id.toString(),
        },
      });

      return {
        success: true,
        data: { message: 'App access granted successfully' },
      };
    });
  }

  /**
   * Offboard a member - set last working date and optional note
   * Member stays active until the last working date, then cron job will deactivate them
   */
  async offboard(
    workspaceId: string,
    memberId: string,
    offboardDto: OffboardMemberDto,
    actorId: string,
  ) {
    return this.withTeamSpan('team.offboard', { workspaceId, memberId }, async () => {
      const { lastWorkingDate, resignationNote } = offboardDto;

      const member = await this.teamModel.findOne({ _id: memberId, workspaceId }).exec();
      if (!member) throw new NotFoundException('Team member not found');

      if (!member.isActive) {
        throw new HttpException(
          { success: false, message: 'Cannot offboard an inactive member' },
          HttpStatus.BAD_REQUEST,
        );
      }

      member.dateOfResignation = new Date(lastWorkingDate);
      if (resignationNote) {
        member.resignationNote = resignationNote;
      }

      await member.save();

      const populated = await this.teamModel
        .findById(memberId)
        .populate(ROLE_POPULATE)
        .populate(SHIFT_POPULATE)
        .exec();

      this.auditTeamEvent({
        action: 'team.offboarded',
        workspaceId,
        actorId,
        memberId,
        actorNameSnapshot: member.name,
        meta: { lastWorkingDate, hasNote: !!resignationNote },
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.offboarded',
        properties: { workspaceId, memberId, hasNote: !!resignationNote },
      });

      return {
        success: true,
        data: { member: this.toResponse(populated ?? member) },
      };
    });
  }

  // ── Private validation helpers ────────────────────────────────────────────

  /**
   * Checks that mobile, email, and PAN are unique within the workspace
   * (excluding archived members and optionally the member being updated).
   */
  private async assertUniqueIdentifiers(
    workspaceId: string,
    payload: { mobile?: string; email?: string; pan?: string },
    excludeId?: string,
  ) {
    const orConditions: Record<string, unknown>[] = [];
    if (payload.mobile) orConditions.push({ mobile: payload.mobile });
    if (payload.email) orConditions.push({ email: payload.email });
    if (payload.pan) orConditions.push({ pan: payload.pan });
    if (orConditions.length === 0) return;

    // Explicit ObjectId cast: Mongoose v8 does not auto-cast string →
    // ObjectId when the query is typed as `Record<string, unknown>`
    // (same trap as the createPayload comment in `create`). Without the
    // cast the query asks for `workspaceId: "<24-hex>"` while the
    // collection stores it as a BSON ObjectId, so the lookup misses
    // every duplicate and the unique-index throws E11000 at insert time
    // instead of a friendly ConflictException.
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
      isDeleted: false,
      $or: orConditions,
    };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };

    const duplicate = await this.teamModel.findOne(query).select('mobile email pan').lean().exec();

    if (!duplicate) return;

    if (payload.mobile && duplicate.mobile === payload.mobile)
      throw new ConflictException(
        `MEMBER_MOBILE_CONFLICT:A team member with mobile ${payload.mobile} already exists in this workspace`,
      );
    if (payload.email && duplicate.email === payload.email)
      throw new ConflictException(
        `MEMBER_EMAIL_CONFLICT:A team member with email ${payload.email} already exists in this workspace`,
      );
    if (payload.pan && duplicate.pan === payload.pan)
      throw new ConflictException(
        `MEMBER_PAN_CONFLICT:A team member with PAN ${payload.pan} already exists in this workspace`,
      );
  }

  /**
   * Read-only availability check used by the frontend wizard / edit page to
   * warn the user before submit. Mirrors the query inside
   * `assertUniqueIdentifiers` but returns availability + conflicting member's
   * display name instead of throwing.
   */
  async checkIdentifierAvailability(
    workspaceId: string,
    args: { mobile?: string; email?: string; excludeId?: string },
  ): Promise<{
    mobile?: { available: boolean; conflictMemberName?: string };
    email?: { available: boolean; conflictMemberName?: string };
  }> {
    const result: {
      mobile?: { available: boolean; conflictMemberName?: string };
      email?: { available: boolean; conflictMemberName?: string };
    } = {};

    // Normalise at the service layer so this works whether the caller
    // already passed the canonical `91XXXXXXXXXX` form (e.g. via the
    // DTO @Transform) or a raw 10-digit / +91-prefixed string.
    const norm = args.mobile ? normaliseIndianMobile(args.mobile) : null;
    const normalisedMobile = norm ? norm.full : undefined;
    const normalisedEmail = args.email ? args.email.trim().toLowerCase() : undefined;

    const orConditions: Record<string, unknown>[] = [];
    if (normalisedMobile) orConditions.push({ mobile: normalisedMobile });
    if (normalisedEmail) orConditions.push({ email: normalisedEmail });
    if (orConditions.length === 0) return result;

    // Explicit ObjectId cast — see `assertUniqueIdentifiers` for the
    // Mongoose v8 auto-cast trap this avoids.
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
      isDeleted: false,
      $or: orConditions,
    };
    if (args.excludeId) query._id = { $ne: new Types.ObjectId(args.excludeId) };

    const duplicates = await this.teamModel.find(query).select('name mobile email').lean().exec();

    if (normalisedMobile) {
      const hit = duplicates.find((d) => d.mobile === normalisedMobile);
      result.mobile = hit
        ? { available: false, conflictMemberName: hit.name }
        : { available: true };
    }
    if (normalisedEmail) {
      const hit = duplicates.find(
        (d) => typeof d.email === 'string' && d.email.toLowerCase() === normalisedEmail,
      );
      result.email = hit ? { available: false, conflictMemberName: hit.name } : { available: true };
    }
    return result;
  }

  /**
   * Returns the full identity-collision picture for a typed mobile number in
   * one read-only round-trip.  Covers all 10 enumerated cases from the
   * Phase 2.0 spec.  Privacy contract (binding):
   *   - Cases 3/4 (platform_user_other_ws): counts only, zero cross-tenant PII.
   *   - Case 7 (team_member_other_ws): kind only.
   *   - Case 10b (pending_invite_other_ws): kind only.
   *
   * This method is a read-only *sibling* of `assertUniqueIdentifiers` —
   * do NOT merge them.  `assertUniqueIdentifiers` remains the authoritative
   * create-time guardrail; this method surfaces the pre-submit picture to the
   * UI.  The `excludeMemberId` param lets an existing member verify their
   * own number without the service flagging them as a self-collision.
   */
  async classifyMobile(
    workspaceId: string,
    mobile: string,
    excludeMemberId?: string,
  ): Promise<MobileClassification> {
    return this.withTeamSpan('team.classifyMobile', { workspaceId }, async (span) => {
      // ── Step 1: Normalise ─────────────────────────────────────────────
      const norm = normaliseIndianMobile(mobile);
      if (!norm) return { kind: 'invalid_format' };
      const { full: normFull } = norm;

      // Resolve the models needed throughout this method.
      const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
        strict: false,
      });
      const workspaceMemberModel = this.moduleRef.get<Model<any>>(
        getModelToken('WorkspaceMember'),
        { strict: false },
      );
      const userModel = this.moduleRef.get<Model<any>>(getModelToken('User'), {
        strict: false,
      });

      // ── Step 2: Workspace-owner check ────────────────────────────────
      const workspace = await workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .select('ownerId')
        .lean()
        .exec();

      if (workspace?.ownerId) {
        const ownerUser = await userModel
          .findById(workspace.ownerId)
          .select('mobile name')
          .lean()
          .exec();
        if (ownerUser) {
          const ownerNorm = normaliseIndianMobile(String(ownerUser.mobile ?? ''));
          if (ownerNorm && ownerNorm.full === normFull) {
            span.setAttribute('team.classify_mobile.case', 'workspace_owner_self');
            return {
              kind: 'workspace_owner_self',
              ownerName: String(ownerUser.name ?? 'You'),
            };
          }
        }
      }

      // ── Step 3: Active TeamMember THIS workspace ──────────────────────
      // Mirror the team list / archived view exclusion: a permanently-deleted
      // row is a tombstone, never a real member, and must not collide. Without
      // this, a permanently-deleted mobile is blocked from re-add forever and
      // the "restore from the archived list" advice points to a list the
      // member no longer appears in.
      const activeMemberQuery: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
        mobile: normFull,
        isDeleted: false,
        isPermanentlyDeleted: { $ne: true },
      };
      if (excludeMemberId) activeMemberQuery._id = { $ne: new Types.ObjectId(excludeMemberId) };

      const activeMember = await this.teamModel
        .findOne(activeMemberQuery)
        .select('_id name')
        .lean()
        .exec();
      if (activeMember) {
        span.setAttribute('team.classify_mobile.case', 'active_member_this_ws');
        return {
          kind: 'active_member_this_ws',
          memberId: String(activeMember._id),
          memberName: String(activeMember.name),
        };
      }

      // ── Step 4: Archived TeamMember THIS workspace ────────────────────
      // Same tombstone exclusion as Step 3 — a permanently-deleted member is
      // gone from the archived list, so it must not surface here either.
      const archivedMemberQuery: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
        mobile: normFull,
        isDeleted: true,
        isPermanentlyDeleted: { $ne: true },
      };
      if (excludeMemberId) archivedMemberQuery._id = { $ne: new Types.ObjectId(excludeMemberId) };

      const archivedMember = await this.teamModel
        .findOne(archivedMemberQuery)
        .select('_id name')
        .lean()
        .exec();
      if (archivedMember) {
        span.setAttribute('team.classify_mobile.case', 'archived_member_this_ws');
        return {
          kind: 'archived_member_this_ws',
          memberId: String(archivedMember._id),
          memberName: String(archivedMember.name),
        };
      }

      // ── Step 5: Pending invite THIS workspace ─────────────────────────
      // Match on both canonical (91XXXXXXXXXX) and bare (10-digit) forms so an
      // invite stored in either format is found correctly.
      const pendingInvitesThisWs = await workspaceMemberModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          inviteeIdentifier: { $in: [normFull, norm.bare] },
          status: 'invited',
          inviteExpiry: { $gt: new Date() },
        })
        .select('_id linkedTeamMemberId inviteExpiry')
        .lean()
        .exec();

      if (pendingInvitesThisWs.length > 0) {
        const invite = pendingInvitesThisWs[0];
        let memberName = 'Pending';
        let memberId = String(invite._id);
        if (invite.linkedTeamMemberId) {
          const linked = await this.teamModel
            .findById(invite.linkedTeamMemberId)
            .select('_id name')
            .lean()
            .exec();
          if (linked) {
            memberName = String(linked.name);
            memberId = String(linked._id);
          }
        }
        span.setAttribute('team.classify_mobile.case', 'pending_invite_this_ws');
        return {
          kind: 'pending_invite_this_ws',
          memberId,
          memberName,
          inviteExpiresAt: new Date(invite.inviteExpiry as Date).toISOString(),
        };
      }

      // ── Step 6: Cross-tenant check (platform User / other-ws member / other-ws invite) ──
      // Any cross-tenant signal collapses to `registered`. We reveal ZERO fields
      // beyond `kind` - no counts, no names, no workspace ids (privacy contract).
      const bare = normFull.replace(/^91/, '');

      // 6a: Platform User row matching the mobile.
      const platformUser = await userModel
        .findOne({ $or: [{ mobile: normFull }, { mobile: bare }] })
        .select('_id')
        .lean()
        .exec();

      if (platformUser) {
        // ANY User row matching the mobile is a cross-tenant signal. We do NOT
        // check workspace counts - that would reveal how many workspaces the user
        // belongs to (a cross-tenant metadata leak).
        span.setAttribute('team.classify_mobile.case', 'registered');
        span.setAttribute('team.classify_mobile.privacy_redacted', true);
        return { kind: 'registered' };
      }

      // 6b: TeamMember row in another workspace (no User row yet).
      const otherWsMember = await this.teamModel
        .findOne({
          mobile: normFull,
          workspaceId: { $ne: new Types.ObjectId(workspaceId) },
          isDeleted: false,
        })
        .select('_id')
        .lean()
        .exec();
      if (otherWsMember) {
        span.setAttribute('team.classify_mobile.case', 'registered');
        span.setAttribute('team.classify_mobile.privacy_redacted', true);
        return { kind: 'registered' };
      }

      // 6c: Pending invite in another workspace. Match both canonical and bare forms.
      const pendingInviteOtherWs = await workspaceMemberModel
        .findOne({
          inviteeIdentifier: { $in: [normFull, bare] },
          workspaceId: { $ne: new Types.ObjectId(workspaceId) },
          status: 'invited',
          inviteExpiry: { $gt: new Date() },
        })
        .select('_id')
        .lean()
        .exec();
      if (pendingInviteOtherWs) {
        span.setAttribute('team.classify_mobile.case', 'registered');
        span.setAttribute('team.classify_mobile.privacy_redacted', true);
        return { kind: 'registered' };
      }

      // ── Step 7: Unregistered ──────────────────────────────────────────
      span.setAttribute('team.classify_mobile.case', 'unregistered');
      return { kind: 'unregistered' };
    });
  }

  /**
   * Validates cross-field date rules:
   * DOB < DOJ, DOJ < DOR, min age 14, DOJ not more than 1 year in the future.
   */
  private assertDateCoherence(payload: {
    dateOfBirth?: string;
    dateOfJoining?: string;
    dateOfResignation?: string;
  }) {
    const { dateOfBirth, dateOfJoining, dateOfResignation } = payload;

    if (dateOfBirth && dateOfJoining) {
      if (new Date(dateOfBirth) >= new Date(dateOfJoining))
        throw new BadRequestException('Date of birth must be before date of joining');
    }

    if (dateOfJoining && dateOfResignation) {
      if (new Date(dateOfJoining) >= new Date(dateOfResignation))
        throw new BadRequestException('Date of resignation must be after date of joining');
    }

    if (dateOfBirth) {
      const ageYears =
        (Date.now() - new Date(dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (ageYears < 14) throw new BadRequestException('Employee must be at least 14 years old');
    }

    if (dateOfJoining) {
      const daysAhead = (new Date(dateOfJoining).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      if (daysAhead > 365)
        throw new BadRequestException('Date of joining cannot be more than 1 year in the future');
    }
  }

  /**
   * Assign employee codes to every non-deleted member that does not already
   * have one. Walks members in createdAt order to preserve joining sequence.
   * Idempotent: members with existing codes are skipped. On completion the
   * workspace counter is advanced to the last-assigned sequence number.
   */
  /**
   * Returns the count of non-archived members that have no employeeCode yet.
   * Matches exactly the filter used by backfillEmployeeCodes so the UI shows
   * the right number without downloading all member records.
   */
  async getPendingBackfillCount(
    workspaceId: string,
  ): Promise<{ total: number; withoutCode: number }> {
    return this.withTeamSpan('team.getPendingBackfillCount', { workspaceId }, async () => {
      const filter = {
        // cast: schema union type suppresses implicit string->ObjectId cast,
        // so a raw string matches 0 docs and the count is wrong.
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: { $ne: true },
        isPermanentlyDeleted: { $ne: true },
      };
      const [total, withoutCode] = await Promise.all([
        this.teamModel.countDocuments(filter).exec(),
        this.teamModel.countDocuments({ ...filter, employeeCode: { $exists: false } }).exec(),
      ]);
      return { total, withoutCode };
    });
  }

  /**
   * Returns bucketed member counts for the team list segmented filter.
   * Matches the exact same semantics as findAll() status filter so list
   * totals and count pills always agree. Excludes permanently deleted.
   *
   * Buckets:
   *   all         — every non-permanently-deleted member (incl. archived)
   *   active      — isActive, not archived, no future resignation date
   *   offboarding — isActive, not archived, dateOfResignation > now
   *   inactive    — !isActive, not archived
   *   archived    — isDeleted: true
   */
  async getStatusCounts(workspaceId: string): Promise<{
    all: number;
    active: number;
    offboarding: number;
    inactive: number;
    archived: number;
  }> {
    return this.withTeamSpan('team.getStatusCounts', { workspaceId }, async () => {
      const now = new Date();

      const base = {
        workspaceId: new Types.ObjectId(workspaceId),
        isPermanentlyDeleted: { $ne: true },
      } as Record<string, unknown>;

      const notArchived = {
        ...base,
        isDeleted: { $ne: true },
      };

      const [all, active, offboarding, inactive, archived] = await Promise.all([
        // all: every member not permanently deleted (includes archived)
        this.teamModel.countDocuments(base).exec(),
        // active: not archived, isActive, no future resignation
        this.teamModel
          .countDocuments({
            ...notArchived,
            isActive: true,
            $or: [
              { dateOfResignation: { $exists: false } },
              { dateOfResignation: null },
              { dateOfResignation: { $lte: now } },
            ],
          })
          .exec(),
        // offboarding: not archived, isActive, future resignation
        this.teamModel
          .countDocuments({
            ...notArchived,
            isActive: true,
            dateOfResignation: { $exists: true, $ne: null, $gt: now },
          })
          .exec(),
        // inactive: not archived, !isActive
        this.teamModel.countDocuments({ ...notArchived, isActive: false }).exec(),
        // archived: soft-deleted (still excludes permanently deleted via base)
        this.teamModel.countDocuments({ ...base, isDeleted: true }).exec(),
      ]);

      return { all, active, offboarding, inactive, archived };
    });
  }

  async backfillEmployeeCodes(workspaceId: string, actorId: string) {
    return this.withTeamSpan('team.backfillEmployeeCodes', { workspaceId }, async () => {
      const workspaceModel = this.moduleRef.get<Model<any>>(getModelToken('Workspace'), {
        strict: false,
      });
      const workspace = await workspaceModel.findById(new Types.ObjectId(workspaceId)).exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      const settings = workspace.employeeCodeSettings as EmployeeCodeSettings | undefined;
      if (!settings?.enabled) {
        throw new BadRequestException({
          success: false,
          message: 'Enable employee codes in workspace settings before running backfill.',
          code: 'EMP_CODE_DISABLED',
        });
      }

      const workspaceCode = await this.ensureWorkspaceCode(workspaceModel, workspace);

      const members = await this.teamModel
        .find({
          // cast: schema union type suppresses implicit string->ObjectId cast,
          // so a raw string matches 0 docs and backfill processes nothing.
          workspaceId: new Types.ObjectId(workspaceId),
          isDeleted: { $ne: true },
          isPermanentlyDeleted: { $ne: true },
        })
        .sort({ createdAt: 1, _id: 1 })
        .exec();

      let lastSeq = await this.workspaceCounterService.getCurrent(workspaceId);
      let assigned = 0;
      let skipped = 0;
      const conflicts: { memberId: string; name: string }[] = [];

      for (const m of members) {
        if (m.employeeCode) {
          skipped++;
          continue;
        }
        let placed = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          lastSeq++;
          const code = renderEmployeeCode(settings.format, settings.prefix, lastSeq, workspaceCode);
          try {
            m.employeeCode = code;
            await m.save();
            placed = true;
            assigned++;
            break;
          } catch (e) {
            if (isEmployeeCodeDuplicate(e)) {
              m.employeeCode = undefined;
              continue;
            }
            throw e;
          }
        }
        if (!placed) {
          conflicts.push({
            memberId: m._id.toString(),
            name: m.name,
          });
        }
      }

      await this.workspaceCounterService.setCounter(workspaceId, lastSeq);

      this.auditTeamEvent({
        action: 'team.employee_codes_backfilled',
        workspaceId,
        actorId,
        meta: { assigned, skipped, conflictCount: conflicts.length, counter: lastSeq },
      });

      return {
        success: true,
        data: {
          assigned,
          skipped,
          conflicts,
          counter: lastSeq,
        },
      };
    });
  }

  async recordStatutoryReveal(
    workspaceId: string,
    memberId: string,
    actorId: string,
    field: 'aadhaar' | 'pan',
  ) {
    return this.withTeamSpan(
      'team.recordStatutoryReveal',
      { workspaceId, memberId, userId: actorId, field },
      async () => {
        const member = await this.teamModel
          .findOne({
            _id: new Types.ObjectId(memberId),
            workspaceId: new Types.ObjectId(workspaceId),
            isDeleted: { $ne: true },
          })
          .select('name')
          .lean()
          .exec();

        if (!member) throw new NotFoundException('Team member not found');

        this.auditTeamEvent({
          action: `team.statutory_reveal_${field}`,
          workspaceId,
          actorId,
          memberId,
          actorNameSnapshot: member.name,
          meta: { field },
        });

        return { success: true };
      },
    );
  }

  // ── Kiosk PIN (M-02) ────────────────────────────────────────────────────

  /**
   * Set or reset the 4-digit kiosk PIN for a team member.
   * PIN is bcrypt-hashed (cost 10) and stored in kioskPinHash.
   * Resets failed-attempt counter and lockout on every admin reset.
   * Validation: pin must match /^\d{4}$/ — enforced by SetKioskPinDto; throws BadRequestException on mismatch.
   */
  async setKioskPin(wsId: string, memberId: string, pin: string, actorId: string): Promise<void> {
    return this.withTeamSpan('team.setKioskPin', { workspaceId: wsId, memberId }, async () => {
      if (!/^\d{4}$/.test(pin)) {
        throw new BadRequestException('PIN must be exactly 4 digits');
      }
      const kioskPinHash = await bcrypt.hash(pin, 10);
      const result = await this.teamModel.updateOne(
        {
          _id: new Types.ObjectId(memberId),
          workspaceId: new Types.ObjectId(wsId),
          isDeleted: { $ne: true },
        },
        {
          $set: {
            kioskPinHash,
            kioskPinSetAt: new Date(),
            kioskFailedAttempts: 0,
            kioskLockedUntil: null,
          },
        },
      );
      if (result.matchedCount === 0) {
        throw new NotFoundException('Team member not found');
      }

      this.auditTeamEvent({
        action: 'team.kiosk_pin_set',
        workspaceId: wsId,
        actorId,
        memberId,
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.kiosk_pin_set',
        properties: { workspaceId: wsId, memberId },
      });
    });
  }

  /**
   * Update karigar profile fields on a TeamMember (D-06).
   * Protected by workspaceId filter — cannot patch members from other workspaces (T-F11-W2-04).
   * Wage rate changes here do NOT retroactively alter KarigarLinkage.wageRateSnapshotPaise (T-F11-W2-02).
   */
  async updateKarigarProfile(
    workspaceId: string,
    memberId: string,
    dto: UpdateKarigarProfileDto,
    actorId: string,
  ): Promise<TeamMember> {
    return this.withTeamSpan('team.updateKarigarProfile', { workspaceId, memberId }, async () => {
      const wsId = new Types.ObjectId(workspaceId);
      const id = new Types.ObjectId(memberId);
      const update: Record<string, unknown> = { isKarigar: dto.isKarigar };
      if (dto.karigarSkillType !== undefined) {
        update.karigarSkillType = dto.karigarSkillType;
      }
      if (dto.karigarDailyRatePaise !== undefined) {
        update.karigarDailyRatePaise = dto.karigarDailyRatePaise;
      }
      const doc = await this.teamModel.findOneAndUpdate(
        { _id: id, workspaceId: wsId },
        { $set: update },
        { new: true },
      );
      if (!doc) {
        throw new NotFoundException(`Team member ${memberId} not found`);
      }

      this.auditTeamEvent({
        action: 'team.karigar_profile_updated',
        workspaceId,
        actorId,
        memberId,
        actorNameSnapshot: doc.name,
        meta: {
          isKarigar: dto.isKarigar,
          skillType: dto.karigarSkillType,
          dailyRatePaise: dto.karigarDailyRatePaise,
        },
      });

      this.postHog.capture({
        distinctId: actorId,
        event: 'team.karigar_profile_updated',
        properties: {
          workspaceId,
          memberId,
          isKarigar: dto.isKarigar,
          skillType: dto.karigarSkillType,
        },
      });

      return doc;
    });
  }

  // ── Phase 23 (D-02) — piece-rate config validation ────────────────────────
  /**
   * Cross-field validator for SetPieceRateConfigDto.
   *
   * Rules enforced:
   *   - effectiveFrom > today           → 400 EFFECTIVE_FROM_FUTURE_NOT_SUPPORTED (D-08 v1)
   *   - duplicate machineId override    → 400 DUPLICATE_MACHINE_OVERRIDE
   *   - override.machineId not in ws    → 400 MACHINE_NOT_FOUND
   *
   * basePortion-zero outside `blended` is a normalisation concern handled by
   * the persistence layer (caller forces basePortion=0 before save). We do
   * not throw here because forms commonly send a stale basePortion when the
   * unit is being switched.
   *
   * Mongoose 8.23 autocast workaround (MACH-P2-XC-06): all _id comparisons
   * wrap with `new Types.ObjectId()`.
   */
  async validatePieceRateConfig(
    dto: SetPieceRateConfigDto,
    workspaceId: string | Types.ObjectId,
  ): Promise<void> {
    if (dto.effectiveFrom && new Date(dto.effectiveFrom) > new Date()) {
      throw new BadRequestException({
        code: 'EFFECTIVE_FROM_FUTURE_NOT_SUPPORTED',
        message: 'Future-dated rate changes are not supported in this version',
      });
    }

    const overrides = dto.perMachineOverrides ?? [];
    if (overrides.length === 0) return;

    // Dedupe machineId
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.machineId)) {
        throw new BadRequestException({
          code: 'DUPLICATE_MACHINE_OVERRIDE',
          message: 'Each machine can have only one override',
        });
      }
      seen.add(o.machineId);
    }

    // All machineIds must exist in this workspace.
    const ids = overrides.map((o) => new Types.ObjectId(o.machineId));
    const wsObjId = new Types.ObjectId(String(workspaceId));
    const found = await this.machineModel
      .find({ _id: { $in: ids }, workspaceId: wsObjId })
      .select('_id')
      .lean()
      .exec();
    if (found.length !== ids.length) {
      throw new BadRequestException({
        code: 'MACHINE_NOT_FOUND',
        message: 'One or more machine overrides reference machines outside this workspace',
      });
    }
  }
}
