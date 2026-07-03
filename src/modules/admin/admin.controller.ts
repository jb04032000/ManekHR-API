import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateUserSessionLimitDto } from '../sessions/dto/sessions.dto';
import { AddOnsService } from '../add-ons/add-ons.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  AdminPaginationDto,
  UpdateUserStatusDto,
  AdminAssignPlanDto,
  AdminAssignDefaultPlanDto,
  AdminCustomAssignDto,
  AdminUpdateSubscriptionDto,
  AdminRevokeSubscriptionDto,
  DeleteUserDto,
  EraseUserDto,
  AdminRestoreDeletionDto,
  CreateUserDto,
  UpdateSettingsDto,
  DefaultBrandingDto,
} from './dto/admin.dto';
import { AccountDeletionService } from '../account-deletion/account-deletion.service';
import { AccountDeletionFinalizeService } from '../account-deletion/account-deletion-finalize.service';
import { BadRequestException } from '@nestjs/common';
import { CreatePlanDto } from '../subscriptions/dto/subscription.dto';
import { CreateTierDto, UpdateTierDto } from './dto/tier.dto';
import { AdminAssignAddOnDto } from '../add-ons/dto/admin-assign-add-on.dto';
import { CreatePtSlabDto, UpdatePtSlabDto } from './dto/pt-slab.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('admin')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly addOnsService: AddOnsService,
    private readonly uploadsService: UploadsService,
    // Account-deletion Phase 1: admin-mediated recovery of a scheduled deletion.
    private readonly accountDeletionService: AccountDeletionService,
    // Phase 7: the COMPLETE admin erase (Connect purge + identity scrub + vendor
    // file delete), behind POST /admin/users/:id/erase.
    private readonly accountDeletionFinalizeService: AccountDeletionFinalizeService,
  ) {}

  // ── Wave 5 — Workspace storage recompute ────────────────────────────────
  // True-up `Workspace.storageUsage.bytes` from the UploadEvent log when the
  // live counter drifts. Admin-only — IsAdminGuard already applied class-wide.

  @Post('workspaces/:wsId/recompute-storage')
  recomputeWorkspaceStorage(
    @Param('wsId') wsId: string,
  ): Promise<{ before: number; after: number; delta: number }> {
    return this.uploadsService.recomputeStorageUsage(wsId);
  }

  @Post('workspaces/recompute-storage-all')
  recomputeAllWorkspaceStorage(): Promise<{
    workspacesProcessed: number;
    totalDelta: number;
  }> {
    return this.uploadsService.recomputeAllStorageUsage();
  }

  @Get('settings')
  getSettings() {
    return this.adminService.getSettings();
  }

  @Patch('settings')
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.adminService.updateSettings(dto);
  }

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  getUsers(@Query() params: AdminPaginationDto) {
    return this.adminService.getUsers(params);
  }

  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.adminService.createUser(dto);
  }

  @Get('users/:id/subscription')
  getUserSubscription(@Param('id') id: string) {
    return this.adminService.getUserSubscription(id);
  }

  @Get('users/:id/subscriptions')
  getUserSubscriptionHistory(@Param('id') id: string) {
    return this.adminService.getUserSubscriptionHistory(id);
  }

  @Get('users/:id')
  getUserDetails(@Param('id') id: string) {
    return this.adminService.getUserDetails(id);
  }

  @Patch('users/:id/status')
  updateUserStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.adminService.updateUserStatus(id, dto);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string, @Body() dto: DeleteUserDto): Promise<{ message: string }> {
    const permanent: boolean = dto.permanent ?? false;
    return this.adminService.deleteUser(id, permanent);
  }

  @Post('users/:id/restore')
  restoreUser(@Param('id') id: string) {
    return this.adminService.restoreUser(id);
  }

  /**
   * Account-deletion Phase 1 (§5/§6) — admin-mediated recovery of a self-serve
   * deletion within the 30-day window. There is NO self-cancel: the suspended
   * user contacts Zari, an admin verifies their identity out-of-band, then calls
   * this to clear the pending markers + reactivate (`isActive=true`). The target
   * is the path id under IsAdminGuard (class-level) — never a body-supplied id.
   * Distinct from `POST users/:id/restore` (the generic admin soft-delete undo):
   * this also clears the per-scope deletion markers and enforces the window.
   */
  @Post('users/:id/restore-deletion')
  restoreDeletion(
    @Param('id') id: string,
    @Body() dto: AdminRestoreDeletionDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.accountDeletionService.restoreDeletion(id, actorId, dto.reason);
  }

  /**
   * OQ-3 / Phase 7 — DPDP account erasure (admin-triggered). Runs the COMPLETE
   * erase: purge the user's Connect content, anonymize identity + scrub ALL Auth
   * secrets and basis-less PII (Bucket C), erase their files at the storage vendor,
   * revoke every session, and RETAIN statutory salary/attendance + billing/GST
   * (Bucket B) per DATA-MAP-AND-RETENTION.md. Admin-only (class-level
   * IsAdminGuard); the actor is the calling admin; the action is audited.
   * `confirm: true` is required so this irreversible erase can't fire by accident.
   *
   * This is the proper replacement for the legacy `DELETE /admin/users/:id`
   * permanent hard-delete, which removed only the user row + owned workspaces +
   * subscriptions and LEFT salary/attendance/Connect/files orphaned. Erasure
   * NEVER hard-deletes statutory records — it anonymizes the User stub, keeps the
   * statutory FKs intact, and purges only the basis-less personal data.
   */
  @Post('users/:id/erase')
  eraseUser(
    @Param('id') id: string,
    @Body() dto: EraseUserDto,
    @CurrentUser('sub') actorId: string,
  ): Promise<void> {
    if (dto.confirm !== true) {
      throw new BadRequestException({
        code: 'ERASURE_CONFIRM_REQUIRED',
        message: 'Account erasure must be explicitly confirmed (confirm: true).',
      });
    }
    return this.accountDeletionFinalizeService.eraseUserCompletely(id, actorId, dto.reason);
  }

  @Get('workspaces')
  getWorkspaces(@Query() params: AdminPaginationDto) {
    return this.adminService.getWorkspaces(params);
  }

  @Get('subscriptions')
  getSubscriptions(@Query() params: AdminPaginationDto) {
    return this.adminService.getSubscriptions(params);
  }

  @Get('plans')
  getPlans(@Query('product') product?: string) {
    return this.adminService.getPlans(product);
  }

  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto) {
    return this.adminService.createPlan(dto);
  }

  @Patch('plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: Partial<CreatePlanDto>) {
    return this.adminService.updatePlan(id, dto);
  }

  @Delete('plans/:id')
  deletePlan(@Param('id') id: string) {
    return this.adminService.deletePlan(id);
  }

  @Post('subscriptions/assign')
  assignPlan(@Body() dto: AdminAssignPlanDto, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.adminService.assignPlan(dto, { _id: adminId });
  }

  // Assign the configured DEFAULT ERP plan to ONE user who has no active plan
  // (admin-side counterpart to the signup auto-assign). Idempotent — a user who
  // already has a live plan is skipped, never duplicated.
  @Post('users/:id/assign-default-plan')
  assignDefaultPlan(
    @Param('id') id: string,
    @Body() dto: AdminAssignDefaultPlanDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.adminService.assignDefaultPlan(id, { _id: adminId }, dto);
  }

  // Bulk backfill: assign the default ERP plan to EVERY user without an
  // active/trial ERP subscription. Safe to re-run (already-covered users are
  // excluded). Returns assigned/skipped/total counts.
  @Post('subscriptions/assign-default-missing')
  assignDefaultPlanToMissing(@Body() dto: AdminAssignDefaultPlanDto, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.adminService.assignDefaultPlanToUsersWithoutPlan({ _id: adminId }, dto);
  }

  @Post('subscriptions/custom-assign')
  customAssignPlan(@Body() dto: AdminCustomAssignDto, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.adminService.customAssignPlan(dto, { _id: adminId });
  }

  @Patch('subscriptions/:id')
  updateSubscription(@Param('id') id: string, @Body() dto: AdminUpdateSubscriptionDto) {
    return this.adminService.updateSubscription(id, dto);
  }

  @Post('subscriptions/:id/cancel')
  cancelSubscription(
    @Param('id') id: string,
    @Body() dto: { note?: string },
  ): Promise<{ message: string; currentPeriodEnd?: Date }> {
    return this.adminService.cancelSubscription(id, dto);
  }

  @Delete('subscriptions/:id')
  revokeSubscription(
    @Param('id') id: string,
    @Body() dto: AdminRevokeSubscriptionDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.adminService.revokeSubscription(id, { _id: adminId }, dto);
  }

  @Get('tiers')
  getTiers(@Query('product') product?: string) {
    return this.adminService.getTiers(product);
  }

  @Post('tiers')
  createTier(@Body() dto: CreateTierDto) {
    return this.adminService.createTier(dto);
  }

  @Patch('tiers/:id')
  updateTier(@Param('id') id: string, @Body() dto: UpdateTierDto) {
    return this.adminService.updateTier(id, dto);
  }

  @Delete('tiers/:id')
  deleteTier(@Param('id') id: string) {
    return this.adminService.deleteTier(id);
  }

  @Patch('users/:id/session-limit')
  updateUserSessionLimit(
    @Param('id') userId: string,
    @Body() body: UpdateUserSessionLimitDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.adminService.updateUserSessionLimit(userId, body.sessionLimitOverride, actorId);
  }

  @Post('maintenance/repair-module-access')
  repairModuleAccess() {
    return this.adminService.repairModuleAccess();
  }

  @Post('maintenance/repair-missing-subfeatures')
  repairMissingSubFeatures() {
    return this.adminService.repairMissingSubFeatures();
  }

  @Get('settings/branding')
  getDefaultBranding() {
    return this.adminService.getDefaultBranding();
  }

  @Patch('settings/branding')
  updateDefaultBranding(@Body() dto: DefaultBrandingDto) {
    return this.adminService.updateDefaultBranding(dto);
  }

  @Get('pt-slabs')
  getPtSlabs() {
    return this.adminService.getPtSlabs();
  }

  @Get('pt-slabs/:state')
  getPtSlab(@Param('state') state: string) {
    return this.adminService.getPtSlab(state);
  }

  @Post('pt-slabs')
  createPtSlab(@Body() dto: CreatePtSlabDto) {
    return this.adminService.createPtSlab(dto);
  }

  @Put('pt-slabs/:state')
  updatePtSlab(@Param('state') state: string, @Body() dto: UpdatePtSlabDto) {
    return this.adminService.updatePtSlab(state, dto);
  }

  @Delete('pt-slabs/:state')
  deletePtSlab(@Param('state') state: string) {
    return this.adminService.deletePtSlab(state);
  }

  @Get('add-ons/definitions')
  getAddOnDefinitions() {
    return this.addOnsService.getAddOnDefinitions();
  }

  @Post('add-ons/definitions')
  async createAddOnDefinition(@Body() dto: any) {
    // Log only the safe identifier, never the full DTO payload (PII risk).
    this.logger.debug(`Create add-on definition (slug=${dto?.slug ?? 'n/a'})`);
    try {
      return await this.addOnsService.createAddOnDefinition(dto);
    } catch (error) {
      this.logger.error(
        `Create add-on definition failed (slug=${dto?.slug ?? 'n/a'})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  @Patch('add-ons/definitions/:id')
  async updateAddOnDefinition(@Param('id') id: string, @Body() dto: any) {
    // Log only safe identifiers, never the full DTO payload (PII risk).
    this.logger.debug(`Update add-on definition (id=${id}, slug=${dto?.slug ?? 'n/a'})`);
    try {
      return await this.addOnsService.updateAddOnDefinition(id, dto);
    } catch (error) {
      this.logger.error(
        `Update add-on definition failed (id=${id})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  @Delete('add-ons/definitions/:id')
  deleteAddOnDefinition(@Param('id') id: string) {
    return this.addOnsService.deleteAddOnDefinition(id);
  }

  @Get('users/:id/add-ons')
  getUserAddOns(@Param('id') id: string) {
    return this.addOnsService.getUserAddOns(id);
  }

  @Post('add-ons/assign')
  assignAddOn(@Body() dto: AdminAssignAddOnDto, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.addOnsService.adminAssignAddOn(adminId, dto);
  }

  @Delete('add-ons/:id/revoke')
  revokeAddOn(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.addOnsService.adminRevokeAddOn(adminId, id);
  }

  @Get('workspaces/:id')
  getWorkspaceDetail(@Param('id') id: string) {
    return this.adminService.getWorkspaceDetail(id);
  }

  @Patch('workspaces/:id/email-config')
  updateWorkspaceEmailConfig(
    @Param('id') id: string,
    @Body()
    body: {
      emailLimitOverride?: number | null;
      smtpConfig?: {
        host?: string;
        port?: number;
        user?: string;
        pass?: string;
        fromEmail?: string;
        fromName?: string;
        secure?: boolean;
        enabled?: boolean;
      };
    },
  ) {
    return this.adminService.updateWorkspaceEmailConfig(id, body);
  }

  @Post('workspaces/:id/test-smtp')
  testSmtpConnection(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub?: string; email?: string };
    return this.adminService.testSmtpConnection(id, user.email ?? '');
  }

  @Post('workspaces/:id/reset-email-usage')
  resetWorkspaceEmailUsage(@Param('id') id: string) {
    return this.adminService.resetWorkspaceEmailUsage(id);
  }
}
