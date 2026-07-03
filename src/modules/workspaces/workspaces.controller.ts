/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- Pre-existing untyped `@Req() req` pattern (Express request lacks JWT shape); documented Phase 5 W5 carry-forward for separate refactor approval. */
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Logger,
} from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
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
import { UpdateKioskSettingsDto } from './dto/kiosk.dto';
import { UpdateNotificationPolicyDto } from './dto/notification-policy.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';
import { AllowWithoutPin } from '../../common/decorators/allow-without-pin.decorator';

// SEC-5 (Workspaces hardening AC-2.1) — the class-level `@LegacyUnclassified`
// debt marker is REMOVED. Every route now carries its own explicit marker:
// workspace-scoped routes use `@RequirePermissions(WORKSPACES, …)`, the public
// invite-token routes use `@Public`, and the user-self routes (list/create own
// workspaces, accept by token, recovery, leave) use `@AuthenticatedOnly` — the
// same posture the RBAC and Auth hardening passes applied. RolesGuard is
// deny-by-default, so an unmarked route would now fail closed.
@Controller('workspaces')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);

  constructor(private readonly workspacesService: WorkspacesService) {}

  // User-self: returns only the caller's own workspaces (findAllForUser uses
  // req.user.sub). No workspace context → @AuthenticatedOnly.
  @Get()
  @AuthenticatedOnly()
  findAll(@Req() req) {
    return this.workspacesService.findAllForUser(req.user.sub);
  }

  // User-self: creates a workspace for the caller. @AuthenticatedOnly.
  //
  // @AllowWithoutPin: this is pre-PIN onboarding - a user who has never set a
  // Quick PIN (e.g. a Connect-only account crossing into ERP) must be able to
  // create their FIRST workspace, which necessarily precedes PIN setup. The
  // global PinUnlockGuard honours this ONLY for no-PIN callers; a PIN-holder who
  // is locked is still blocked from creating workspaces. After create succeeds
  // the web shell routes the user to /auth/setup-pin. Without this, the create
  // POST 423'd once the 5-min setup-grace expired and /auth/setup-workspace
  // failed. Cross-links: common/guards/pin-unlock.guard.ts.
  @Post()
  @AuthenticatedOnly()
  @AllowWithoutPin()
  create(@Req() req, @Body() createWorkspaceDto: CreateWorkspaceDto) {
    this.logger.log(
      `create HTTP hit user=${req.user.sub} dto=${JSON.stringify(createWorkspaceDto)}`,
    );
    return this.workspacesService.create(req.user.sub, createWorkspaceDto);
  }

  // ── OQ-W3 (approved Option A) — workspace-delete undo / recovery ──────────
  // User-self: the caller's own recently-deleted, still-restorable workspaces.
  // Lives BEFORE `GET /:id` so the literal `deleted` path is not captured by the
  // `:id` route param. Owner-only is enforced in the service (filters ownerId).
  @Get('deleted')
  @AuthenticatedOnly()
  listRestorable(@Req() req) {
    return this.workspacesService.listRestorableWorkspaces(req.user.sub);
  }

  @Get(':id')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  async findOne(@Param('id') id: string) {
    const workspace = await this.workspacesService.findById(id);
    const members = await this.workspacesService.getMembers(id);
    return { workspace, members };
  }

  @Patch(':id')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  update(@Param('id') id: string, @Body() updateWorkspaceDto: UpdateWorkspaceDto) {
    return this.workspacesService.update(id, updateWorkspaceDto);
  }

  // Service additionally enforces explicit owner-only check via
  // isWorkspaceOwner (workspaces.service.ts) — this decorator adds defense
  // in depth: RolesGuard owner-bypass passes through, non-owner Admins are
  // 403'd at the guard. Wave 5 W5.1 (2026-05-10).
  @Delete(':id')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.REMOVE)
  remove(@Param('id') id: string, @Req() req) {
    return this.workspacesService.remove(id, req.user.sub);
  }

  // ── OQ-W3 (approved Option A) — restore a soft-deleted workspace ──────────
  // The target workspace is soft-deleted, so RolesGuard cannot resolve an active
  // membership for a `@RequirePermissions` marker (a deleted workspace fails
  // closed in the guard). Gate as @AuthenticatedOnly; the SERVICE re-checks
  // `isWorkspaceOwner` (same owner-only gate as delete) and the 30-day window.
  @Post(':id/restore')
  @AuthenticatedOnly()
  restore(@Param('id') id: string, @Req() req) {
    return this.workspacesService.restore(id, req.user.sub);
  }

  @Get(':id/members')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  getMembers(@Param('id') id: string) {
    return this.workspacesService.getMembers(id);
  }

  @Post(':id/invite')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  inviteMember(@Param('id') id: string, @Req() req, @Body() inviteDto: InviteMemberDto) {
    return this.workspacesService.inviteMember(id, req.user.sub, inviteDto);
  }

  @Delete(':id/members/:memberId')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.REMOVE)
  removeMember(@Param('id') id: string, @Param('memberId') memberId: string, @Req() req) {
    return this.workspacesService.removeMember(id, memberId, req.user.sub);
  }

  // ── OQ-W6 (approved Option C) — self-serve "Leave workspace" ──────────────
  // Any ACTIVE member may leave on their own (the deliberate exception to the
  // "Cannot remove yourself" block). @AuthenticatedOnly — NOT WORKSPACES.REMOVE,
  // because a Worker/Karigar has no REMOVE grant yet must still be able to exit a
  // workspace they were added to. The service blocks the owner and scopes the
  // teardown to this one workspace.
  @Post(':id/leave')
  @AuthenticatedOnly()
  leaveWorkspace(@Param('id') id: string, @Req() req) {
    return this.workspacesService.leaveWorkspace(id, req.user.sub);
  }

  // G2 fix (Wave 2 W2.7) — was unguarded; any active member could change
  // anyone's role. Now requires WORKSPACES.EDIT, which until system roles
  // ship is effectively workspace-owner-only via the RolesGuard owner-bypass
  // path. Explicit guard prevents privilege escalation by default.
  @Patch(':id/members/:memberId/role')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  changeMemberRole(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Req() req,
    @Body() changeRoleDto: ChangeMemberRoleDto,
  ) {
    return this.workspacesService.changeMemberRole(id, memberId, req.user.sub, changeRoleDto);
  }

  @Get(':id/invitations')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  getPendingInvitations(@Param('id') id: string) {
    return this.workspacesService.getPendingInvitations(id);
  }

  @Post(':id/invitations/:memberId/resend')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  resendInvite(@Param('id') id: string, @Param('memberId') memberId: string, @Req() req) {
    return this.workspacesService.resendInvite(id, memberId, req.user.sub);
  }

  @Delete(':id/invitations/:memberId')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  cancelInvite(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.workspacesService.cancelInvite(id, memberId);
  }

  @Public()
  @Get('join/:token')
  getInviteDetails(@Param('token') token: string) {
    return this.workspacesService.getInviteDetails(token);
  }

  @Public()
  @Delete('join/:token')
  declineInvite(@Param('token') token: string) {
    return this.workspacesService.declineInvite(token);
  }

  // User-self: the caller accepts their own invite by token. The `:token` param
  // is not a workspace id, so there is no workspace context to gate on →
  // @AuthenticatedOnly (the service binds + verifies the invite to the caller).
  @Post('join/:token')
  @AuthenticatedOnly()
  joinWithToken(@Param('token') token: string, @Req() req) {
    return this.workspacesService.joinWithToken(token, req.user.sub);
  }

  @Get(':id/branding')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  getBranding(@Param('id') id: string) {
    return this.workspacesService.getBranding(id);
  }

  @Patch(':id/branding')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'workspace_branding',
  })
  updateBranding(@Param('id') id: string, @Body() dto: BrandingDto) {
    return this.workspacesService.updateBranding(id, dto);
  }

  @Patch(':id/export-preferences')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'workspace_branding',
  })
  updateExportPreferences(@Param('id') id: string, @Body() dto: ExportPreferencesDto) {
    return this.workspacesService.updateExportPreferences(id, dto);
  }

  @Get(':id/employee-code-settings')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  getEmployeeCodeSettings(@Param('id') id: string) {
    return this.workspacesService.getEmployeeCodeSettings(id);
  }

  @Patch(':id/employee-code-settings')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  updateEmployeeCodeSettings(@Param('id') id: string, @Body() dto: EmployeeCodeSettingsDto) {
    return this.workspacesService.updateEmployeeCodeSettings(id, dto);
  }

  // â”€â”€ Kiosk endpoints (M-02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Patch(':id/kiosk')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  updateKiosk(@Param('id') id: string, @Body() dto: UpdateKioskSettingsDto) {
    return this.workspacesService.updateKioskSettings(id, dto);
  }

  // ── Designations sub-resource (F1, 2026-05-13) ────────────────────────────
  // Per-locale labels, cascade-on-rename, block-on-delete-if-in-use. Mobile-app
  // contract preserved via canonical-en mirror on `team_member.designation`.

  @Get(':id/designations')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  listDesignations(@Param('id') id: string) {
    return this.workspacesService.listDesignations(id);
  }

  @Post(':id/designations')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  addDesignation(@Param('id') id: string, @Req() req, @Body() dto: AddDesignationDto) {
    return this.workspacesService.addDesignation(id, dto, req.user.sub);
  }

  @Get(':id/designations/:canonical/usage')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  getDesignationUsage(@Param('id') id: string, @Param('canonical') canonical: string) {
    return this.workspacesService.getDesignationUsage(id, canonical);
  }

  @Patch(':id/designations/:canonical')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  renameDesignation(
    @Param('id') id: string,
    @Param('canonical') canonical: string,
    @Req() req,
    @Body() dto: RenameDesignationDto,
  ) {
    return this.workspacesService.renameDesignation(id, canonical, dto, req.user.sub);
  }

  @Delete(':id/designations/:canonical')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  deleteDesignation(@Param('id') id: string, @Param('canonical') canonical: string, @Req() req) {
    return this.workspacesService.deleteDesignation(id, canonical, req.user.sub);
  }

  @Post(':id/kiosk/regenerate-token')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SETTINGS,
    subFeature: 'edit_settings',
  })
  regenerateToken(@Param('id') id: string) {
    return this.workspacesService.regenerateKioskToken(id);
  }

  // ── Defaulter-alert config (Attendance Defaulter Notification) ────────────

  @Patch(':id/defaulter-alerts')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.ATTENDANCE,
    subFeature: 'defaulter_alerts',
  })
  updateDefaulterAlerts(@Param('id') id: string, @Body() dto: DefaulterAlertsConfigDto) {
    return this.workspacesService.updateDefaulterAlertsConfig(id, dto);
  }

  // ── Notification-policy config (Phase 2.2) ────────────────────────────────

  @Patch(':id/notification-policy')
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
  updateNotificationPolicy(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationPolicyDto,
    @Req() req,
  ) {
    return this.workspacesService.updateNotificationPolicy(id, req.user.sub, dto);
  }
}
