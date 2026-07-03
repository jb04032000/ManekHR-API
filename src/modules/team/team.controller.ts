import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Query,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { TeamService } from './team.service';
import { MobileOtpService } from './mobile-otp.service';
import { TeamMemberDocumentsService } from './team-member-documents.service';
import { SalaryService } from '../salary/salary.service';
import { SetPieceRateConfigDto } from './dto/piece-rate-config.dto';
import { ResourceScopeGuard } from '../../common/guards/resource-scope.guard';
import { SALARY_PERMISSIONS } from '../rbac/permissions.constants';
import {
  CreateTeamMemberDto,
  UpdateTeamMemberDto,
  GrantAccessDto,
  ImportMembersDto,
  OffboardMemberDto,
  BulkStatusDto,
  BulkDeleteDto,
  BulkRestoreDto,
  BulkCreateTeamMembersDto,
  RevealStatutoryDto,
} from './dto/team.dto';
import { CreateTeamMemberDocumentDto } from './dto/team-member-document.dto';
import { SetKioskPinDto } from './dto/kiosk-pin.dto';
import { CheckIdentifierQueryDto } from './dto/check-identifier.dto';
import { TeamActivityQueryDto } from './dto/team-activity-query.dto';
import {
  RevokeAccessDto,
  ResendInviteDto,
  ChangeAccessRoleDto,
  SetPermissionOverridesDto,
} from './dto/access.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UpdateKarigarProfileDto } from './dto/update-karigar-profile.dto';
import {
  StartVerifyMobileDto,
  ConfirmVerifyMobileDto,
  VerifyExistingMobileDto,
} from './dto/verify-mobile.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

@Controller('workspaces/:workspaceId/team')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class TeamController {
  constructor(
    private readonly teamService: TeamService,
    private readonly mobileOtpService: MobileOtpService,
    private readonly documentsService: TeamMemberDocumentsService,
    @Inject(forwardRef(() => SalaryService))
    private readonly salaryService: SalaryService,
  ) {}

  @Post()
  @RequirePermission('team.member.create')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'add_member' })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Body() createDto: CreateTeamMemberDto,
  ) {
    return this.teamService.create(workspaceId, req.user.sub, createDto);
  }

  @Get()
  @RequirePermission('team.directory.view', 'self')
  findAll(
    @Param('workspaceId') workspaceId: string,
    @Query() query: PaginationDto,
    @Query('isKarigar') isKarigar: string,
    @Req() req: any,
  ) {
    const caMode = !!req.user?.accountantWorkspaces?.includes(workspaceId);
    return this.teamService.findAll(
      workspaceId,
      { ...query, isKarigar: isKarigar === 'true' ? true : undefined },
      caMode,
      req.user.sub,
    );
  }

  // â”€â”€ Static routes (must come before /:memberId) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Patch('bulk-status')
  @RequirePermission('team.profile.job.edit', 'all')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'bulk_deactivate',
  })
  bulkUpdateStatus(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BulkStatusDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.bulkUpdateStatus(workspaceId, dto.memberIds, dto.status, req.user.sub);
  }

  @Patch('bulk-restore')
  @RequirePermission('team.member.delete')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'bulk_restore' })
  bulkRestore(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BulkRestoreDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.bulkRestore(workspaceId, dto.memberIds, req.user.sub);
  }

  @Delete('bulk')
  @RequirePermission('team.member.delete')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'bulk_archive' })
  bulkDelete(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BulkDeleteDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.bulkDelete(workspaceId, dto.memberIds, req.user.sub);
  }

  // CSV bulk import. Web import wizard -> here. Static path declared before
  // `@Get(':memberId')` so "bulk-create" is never read as a member id. Reuses
  // the single-create permission/subscription gates; the service loops
  // create() per row so each member gets the same validation + employee-code
  // generation, and returns a per-row success/failure report (partial success
  // is normal). The wizard PIN-gates the call client-side before sending.
  @Post('bulk-create')
  @RequirePermission('team.member.create')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'add_member' })
  bulkCreate(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BulkCreateTeamMembersDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.bulkCreate(workspaceId, req.user.sub, dto.members);
  }

  // §7 Part B — console-only aggregate reads. Scope `'all'` so a
  // self-scoped member (who has at most one row) cannot pull workspace-wide
  // counts. The guard rejects them outright; no service-layer threading.
  @Get('pending-backfill-count')
  @RequirePermission('team.directory.view', 'all')
  getPendingBackfillCount(@Param('workspaceId') workspaceId: string) {
    return this.teamService.getPendingBackfillCount(workspaceId);
  }

  @Get('status-counts')
  @RequirePermission('team.directory.view', 'all')
  getStatusCounts(@Param('workspaceId') workspaceId: string) {
    return this.teamService.getStatusCounts(workspaceId);
  }

  // Workspace-wide team activity feed (who did what to whom). Static path,
  // declared before `@Get(':memberId')` so "activity" is not captured as a
  // member id. Gated to access managers + owner; service redacts sensitive
  // values before returning.
  @Get('activity')
  @RequirePermission('team.appAccess.manage')
  listTeamActivity(
    @Param('workspaceId') workspaceId: string,
    @Query() query: TeamActivityQueryDto,
  ) {
    return this.teamService.listTeamActivity(workspaceId, {
      actorId: query.actorId,
      action: query.action,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('check-identifier')
  @RequirePermission('team.directory.view', 'all')
  async checkIdentifier(
    @Param('workspaceId') workspaceId: string,
    @Query() query: CheckIdentifierQueryDto,
  ) {
    // Legacy path (classify absent or false) — return unchanged shape.
    if (!query.classify) {
      return this.teamService.checkIdentifierAvailability(workspaceId, {
        mobile: query.mobile,
        email: query.email,
        excludeId: query.excludeId,
      });
    }

    // Extended classification path — wraps the legacy result with the
    // full MobileClassification discriminated union.  Email-only callers
    // still receive mobileStatus: null (no classification done for email).
    const availability = await this.teamService.checkIdentifierAvailability(workspaceId, {
      mobile: query.mobile,
      email: query.email,
      excludeId: query.excludeId,
    });

    if (!query.mobile) {
      return { ...availability, mobileStatus: null };
    }

    const mobileStatus = await this.teamService.classifyMobile(
      workspaceId,
      query.mobile,
      query.excludeId,
    );
    return { ...availability, mobileStatus };
  }

  @Post('backfill-employee-codes')
  @RequirePermission('team.profile.job.edit', 'all')
  backfillEmployeeCodes(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.backfillEmployeeCodes(workspaceId, req.user.sub);
  }

  // -- Mobile OTP verification endpoints (Phase 1f.1) -----------------------
  // Must remain BEFORE the dynamic /:memberId routes so NestJS does not
  // mistake “verify-mobile” for a memberId segment.

  /**
   * Step 1 of mobile verification: generate an OTP and send it via SMS.
   * Returns { sent: true, expiresAt } on success.
   * Requires team.member.create permission (same as the add-member flow).
   *
   * Throttler tier `team-mobile-otp-start` caps per-IP + per-userId abuse
   * on top of the per-(workspace,mobile) cooldown + per-workspace burst
   * cap already enforced inside MobileOtpService.
   */
  @Throttle({ 'team-mobile-otp-start': { limit: 10, ttl: 60_000 } })
  @Post('verify-mobile/start')
  @RequirePermission('team.member.create')
  startMobileVerification(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: StartVerifyMobileDto,
    @Req() req: any,
  ) {
    return this.mobileOtpService.startVerification(workspaceId, dto.mobile, req.user.sub);
  }

  /**
   * Step 2 of mobile verification: submit the 6-digit code. On match,
   * returns a short-lived JWT proof token { token, expiresAt } (15 min TTL).
   * Pass this token as mobileVerifyToken in POST /team to stamp
   * mobileVerifiedAt on the new TeamMember.
   *
   * Throttler tier `team-mobile-otp-confirm` is more generous than `start`
   * (30/min vs 10/min) because the UI may retry on flaky-network state and
   * the confirm path is cheap (bcrypt compare + JWT sign, no SMS spend).
   * The MAX_ATTEMPTS=5 doc-level lock still caps brute-force on the code.
   */
  @Throttle({ 'team-mobile-otp-confirm': { limit: 30, ttl: 60_000 } })
  @Post('verify-mobile/confirm')
  @RequirePermission('team.member.create')
  confirmMobileVerification(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ConfirmVerifyMobileDto,
    @Req() req: any,
  ) {
    return this.mobileOtpService.confirmVerification(
      workspaceId,
      dto.mobile,
      dto.code,
      req.user.sub,
    );
  }

  // -- Dynamic routes --------------------------------------------------------

  @Get(':memberId')
  @RequirePermission('team.directory.view', 'self')
  findOne(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req: any,
  ) {
    const caMode = !!req.user?.accountantWorkspaces?.includes(workspaceId);
    return this.teamService.findById(workspaceId, memberId, caMode, req.user.sub);
  }

  // Member-scoped activity feed. Gated to access managers + owner; redacted.
  @Get(':memberId/activity')
  @RequirePermission('team.appAccess.manage')
  listMemberActivity(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.teamService.listMemberActivity(workspaceId, memberId);
  }

  @Patch(':memberId')
  @RequirePermission('team.profile.personal.edit', 'self')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'edit_member' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() updateDto: UpdateTeamMemberDto,
    @Req() req,
  ) {
    return this.teamService.update(workspaceId, memberId, updateDto, req.user.sub);
  }

  /**
   * Phase 1f verify-later flow (2026-05-21). Stamps mobileVerifiedAt on an
   * already-saved member when the owner skipped OTP at add-member time and
   * is now confirming the number from the profile page. Takes a fresh proof
   * token minted by `verify-mobile/confirm` and validated against the
   * member's current mobile.
   *
   * Throttled under the same confirm tier as the add-member flow; gated on
   * `team.member.create` because verifying someone else's mobile carries
   * the same SMS-credit + identity-binding authority.
   */
  @Throttle({ 'team-mobile-otp-confirm': { limit: 30, ttl: 60_000 } })
  @Post(':memberId/verify-mobile')
  @RequirePermission('team.member.create')
  verifyExistingMobile(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() dto: VerifyExistingMobileDto,
    @Req() req: any,
  ) {
    return this.teamService.verifyExistingMemberMobile(
      workspaceId,
      memberId,
      dto.mobileVerifyToken,
      req.user.sub,
    );
  }

  @Delete(':memberId')
  @RequirePermission('team.member.delete')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'remove_member' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.remove(workspaceId, memberId, req.user.sub);
  }

  @Post(':memberId/grant-access')
  @RequirePermission('team.appAccess.manage')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'grant_app_access',
  })
  grantAccess(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() grantDto: GrantAccessDto,
  ) {
    return this.teamService.grantAccess(workspaceId, memberId, req.user.sub, grantDto);
  }

  /**
   * P1.8.1 (2026-05-14) — context-aware grant-flow prelude.
   * VIEW permission (read-only); no subscription gate because the rail
   * surface that consumes it must render even when the owner is in
   * read-only / grace state (paywall handled by the mutation, not the
   * preview).
   */
  @Get(':memberId/grant-context')
  @RequirePermission('team.appAccess.manage')
  grantContext(@Param('workspaceId') workspaceId: string, @Param('memberId') memberId: string) {
    return this.teamService.getGrantContext(workspaceId, memberId);
  }

  @Post('import')
  @RequirePermission('team.member.create')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'bulk_import' })
  importMembers(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Body() importDto: ImportMembersDto,
  ) {
    return this.teamService.importMembers(workspaceId, importDto, req.user.sub);
  }

  @Post(':memberId/offboard')
  @RequirePermission('team.member.delete')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'offboard_member',
  })
  offboard(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() offboardDto: OffboardMemberDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.offboard(workspaceId, memberId, offboardDto, req.user.sub);
  }

  // ── App Access Management (P1+P2+P3) ─────────────────────────────────────
  // All four routes mirror grant-access' permission + subscription gates so a
  // workspace that's locked out of `grant_app_access` cannot reach any of
  // these mutations either.
  //
  // P1.8-revert.15 (2026-05-14) — the previous arrangement chained the
  // @Post(':memberId/reveal-audit') decorator above @Post(':memberId/
  // revoke-access') on the same revokeAccess method (the revealAudit
  // method below it had been left without a decorator). NestJS applied
  // both @Post decorators to revokeAccess; the second one (reveal-audit,
  // applied last in declaration order, so first in TS decorator order)
  // overwrote the route metadata. Net: /revoke-access returned 404
  // ("Cannot POST"). revealAudit was unreachable too. Fix is purely
  // attribution — moved the reveal-audit decorator down to its real
  // handler.
  @Post(':memberId/revoke-access')
  @RequirePermission('team.appAccess.manage')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'grant_app_access',
  })
  revokeAccess(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: RevokeAccessDto,
  ) {
    return this.teamService.revokeAccess(workspaceId, memberId, req.user.sub, dto);
  }

  @Post(':memberId/resend-invite')
  @RequirePermission('team.appAccess.manage')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'grant_app_access',
  })
  resendInvite(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: ResendInviteDto,
  ) {
    return this.teamService.resendInvite(workspaceId, memberId, req.user.sub, dto);
  }

  @Patch(':memberId/access-role')
  @RequirePermission('team.appAccess.manage')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'grant_app_access',
  })
  changeAccessRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: ChangeAccessRoleDto,
  ) {
    return this.teamService.changeAccessRole(workspaceId, memberId, req.user.sub, dto);
  }

  @Put(':memberId/permission-overrides')
  @RequirePermission('team.appAccess.manage')
  @RequireSubscription({
    module: AppModule.TEAM,
    subFeature: 'grant_app_access',
  })
  setPermissionOverrides(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: SetPermissionOverridesDto,
  ) {
    return this.teamService.setPermissionOverrides(workspaceId, memberId, req.user.sub, dto);
  }

  @Post(':memberId/reveal-audit')
  @RequirePermission('team.profile.statutory.view', 'all')
  revealAudit(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: RevealStatutoryDto,
  ) {
    return this.teamService.recordStatutoryReveal(workspaceId, memberId, req.user.sub, dto.field);
  }

  // â”€â”€ Documents sub-resource â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Get(':memberId/documents')
  @RequirePermission('team.profile.documents.view', 'self')
  async listDocuments(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
  ) {
    // §7 Part B — a self-scoped caller may list only their own documents.
    await this.teamService.assertMemberReadScope(workspaceId, req.user.sub, memberId);
    return this.documentsService.list(workspaceId, memberId);
  }

  @Post(':memberId/documents')
  @RequirePermission('team.profile.documents.edit', 'self')
  createDocument(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() dto: CreateTeamMemberDocumentDto,
  ) {
    return this.documentsService.create(workspaceId, memberId, req.user.sub, dto);
  }

  @Delete(':memberId/documents/:docId')
  @RequirePermission('team.profile.documents.edit', 'all')
  removeDocument(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Param('docId') docId: string,
  ) {
    return this.documentsService.remove(workspaceId, memberId, docId);
  }

  // â”€â”€ Sub-resource routes (after /:memberId, no ordering conflict) â”€â”€â”€â”€â”€

  @Patch(':memberId/restore')
  @RequirePermission('team.member.delete')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'restore_member' })
  restore(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.restore(workspaceId, memberId, req.user.sub);
  }

  @Delete(':memberId/permanent')
  @RequirePermission('team.member.delete_permanent')
  @RequireSubscription({ module: AppModule.TEAM, subFeature: 'remove_member' })
  removePermanent(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.removePermanent(workspaceId, memberId, req.user.sub);
  }

  // â”€â”€ Karigar profile (F-11 D-06) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * PATCH /workspaces/:workspaceId/team/:memberId/karigar
   * Sets karigar profile fields: isKarigar, karigarSkillType, karigarDailyRatePaise.
   * Gated by manage_team (RBAC TEAM.EDIT) â€” T-F11-W2-03 elevation-of-privilege mitigation.
   * Cross-workspace update prevented by workspaceId filter in service â€” T-F11-W2-04.
   */
  @Patch(':memberId/karigar')
  @RequirePermission('team.profile.pay.edit', 'all')
  async updateKarigarProfile(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateKarigarProfileDto,
    @Req() req: { user: { sub: string } },
  ) {
    const member = await this.teamService.updateKarigarProfile(
      workspaceId,
      memberId,
      dto,
      req.user.sub,
    );
    return { success: true, data: { member } };
  }

  // â”€â”€ Kiosk PIN (M-02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Post(':id/kiosk-pin')
  @RequirePermission('team.profile.job.edit', 'all')
  setKioskPin(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: SetKioskPinDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.teamService.setKioskPin(workspaceId, id, dto.pin, req.user.sub);
  }

  // â”€â”€ Phase 23 (D-11) â€” Piece-Rate Config Endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // PATCH/DELETE /workspaces/:workspaceId/team/:teamMemberId/piece-rate-config
  //
  // Permission: 'salary.piece_rate.manage' (SALARY module action â€” D-10).
  // Sub-feature gate: piece_rate_payroll on MACHINES.
  // Guard chain includes ResourceScopeGuard (BLOCKER 3 / MACH-P2-XC-04) so
  // the request is decorated with req.resourceScope. There is no current
  // member-level scope helper (assertMemberInScope); machine-scope rows are
  // already validated inside the perMachineOverrides cross-field check
  // (TeamService.validatePieceRateConfig â€” workspaceId-bounded query).

  @Patch(':teamMemberId/piece-rate-config')
  @UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
  @RequirePermissions(AppModule.SALARY, SALARY_PERMISSIONS.MANAGE_PIECE_RATE)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'piece_rate_payroll',
  })
  setPieceRateConfig(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Body() dto: SetPieceRateConfigDto,
    @Req() req: any,
  ) {
    return this.salaryService.setPieceRateConfig(workspaceId, teamMemberId, dto, req.user.sub);
  }

  @Delete(':teamMemberId/piece-rate-config')
  @UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
  @RequirePermissions(AppModule.SALARY, SALARY_PERMISSIONS.MANAGE_PIECE_RATE)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'piece_rate_payroll',
  })
  clearPieceRateConfig(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Body() body: { downgradeTo?: 'monthly' | 'hourly' },
    @Req() req: any,
  ) {
    return this.salaryService.clearPieceRateConfig(
      workspaceId,
      teamMemberId,
      body?.downgradeTo ?? 'monthly',
      req.user.sub,
    );
  }
}

/**
 * Separate controller for routes without workspace prefix
 */
@LegacyUnclassified()
@Controller('team')
@UseGuards(JwtAuthGuard)
export class TeamPublicController {
  constructor(private readonly teamService: TeamService) {}

  @Post('accept-invite/:token')
  acceptInvite(@Param('token') token: string, @Req() req) {
    return this.teamService.acceptInvite(token, req.user.sub);
  }
}
