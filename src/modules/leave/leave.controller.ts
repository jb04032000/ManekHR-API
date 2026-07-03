import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { LeaveService } from './leave.service';
import { LeaveRequestService } from './leave-request.service';
import { LeaveLedgerService } from './leave-ledger.service';
import { LeaveSettingsService } from './leave-settings.service';
import { LeaveNotificationService } from './leave-notification.service';
import {
  ApplyLeaveDto,
  CreateLeaveTypeDto,
  DecideLeaveDto,
  GetBalancesQuery,
  LeaveCalendarQuery,
  ListLeaveRequestsQuery,
  ListLeaveTypesQuery,
  PostAdjustmentDto,
  TeamConflictQuery,
  UpdateLeaveSettingsDto,
  UpdateLeaveTypeDto,
} from './dto/leave.dto';

/**
 * Leave Management routes — L3a apply path.
 *
 * Scope split mirrors `RegularizationController`:
 *   - `types` / `balances` / `requests/mine` / apply → `'self'` scope (a
 *     self-scoped Worker sees + applies for their own leave only).
 *   - `requests` / `requests/:id` → `'all'` (manager/HR queue).
 *   - `settings` → `manage_leave` (HR).
 */
@ApiTags('Leave')
@Controller('workspaces/:wsId/leave')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class LeaveController {
  constructor(
    private readonly leaveService: LeaveService,
    private readonly requestService: LeaveRequestService,
    private readonly ledgerService: LeaveLedgerService,
    private readonly settingsService: LeaveSettingsService,
    private readonly callerScope: CallerScopeService,
    private readonly notificationService: LeaveNotificationService,
  ) {}

  @Get('types')
  @ApiOperation({ summary: 'List the workspace leave-type catalogue' })
  @ApiResponse({ status: 200, description: 'Array of leave types, display-ordered' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async types(@Param('wsId') wsId: string, @Query() q: ListLeaveTypesQuery) {
    const data = await this.leaveService.listLeaveTypes(wsId, q.includeInactive === true);
    return { success: true, data };
  }

  /** Create a leave type — HR catalogue configuration (L5a). */
  @Post('types')
  @ApiOperation({ summary: 'Create a leave type' })
  @ApiResponse({ status: 201, description: 'Leave type created' })
  @ApiResponse({ status: 400, description: 'Duplicate leave-type code' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.type.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async createType(
    @Param('wsId') wsId: string,
    @Body() dto: CreateLeaveTypeDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.leaveService.createLeaveType(wsId, dto, req.user.sub);
    return { success: true, data };
  }

  /** Update a leave type. System types accept only label / colour / order edits. */
  @Put('types/:id')
  @ApiOperation({ summary: 'Update a leave type (system types: label/colour/order only)' })
  @ApiResponse({ status: 200, description: 'Updated leave type' })
  @ApiResponse({ status: 400, description: 'Disallowed edit on a system leave type' })
  @ApiResponse({ status: 404, description: 'Leave type not found' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.type.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async updateType(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLeaveTypeDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.leaveService.updateLeaveType(wsId, id, dto, req.user.sub);
    return { success: true, data };
  }

  /** Archive a leave type — soft delete (`isActive: false`); history preserved. */
  @Delete('types/:id')
  @ApiOperation({ summary: 'Archive a leave type (soft delete; history preserved)' })
  @ApiResponse({ status: 200, description: 'Archived leave type' })
  @ApiResponse({ status: 400, description: 'System leave types cannot be removed' })
  @ApiResponse({ status: 404, description: 'Leave type not found' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.type.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async deleteType(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.leaveService.deleteLeaveType(wsId, id, req.user.sub);
    return { success: true, data };
  }

  @Get('balances')
  @ApiOperation({ summary: 'Get leave balances for a member and year' })
  @ApiResponse({ status: 200, description: 'Per-leave-type balance summary' })
  @ApiResponse({ status: 403, description: 'Caller has no team-directory record' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.balance.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async balances(
    @Param('wsId') wsId: string,
    @Query() q: GetBalancesQuery,
    @Req() req: { user: { sub: string } },
  ) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectivePathScope(ctx, 'leave.balance.view');
    const selfScoped = !ctx.isOwner && scope === 'self';

    let targetMemberId = q.memberId;
    if (selfScoped || !targetMemberId) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException('Your account has no team-directory record.');
      }
      targetMemberId = ctx.teamMemberId;
    }

    const resolvedYear = q.year ?? new Date().getUTCFullYear();
    const data = await this.ledgerService.getBalances(
      new Types.ObjectId(wsId),
      new Types.ObjectId(targetMemberId),
      resolvedYear,
    );
    return { success: true, data };
  }

  /** Every member's balances for one leave year — the HR balances admin table. */
  @Get('balances/all')
  @ApiOperation({ summary: 'List every member balance for a leave year (HR admin)' })
  @ApiResponse({ status: 200, description: 'Workspace-wide balance rows' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.balance.view', 'all')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async allBalances(@Param('wsId') wsId: string, @Query('year') year: string | undefined) {
    const resolvedYear = year ? Number.parseInt(year, 10) : new Date().getUTCFullYear();
    const data = await this.ledgerService.getWorkspaceBalances(
      new Types.ObjectId(wsId),
      resolvedYear,
    );
    return { success: true, data };
  }

  /** HR manual balance correction — posts a signed `adjustment` ledger entry. */
  @Post('adjustments')
  @ApiOperation({ summary: 'Post a manual leave-balance adjustment (HR correction)' })
  @ApiResponse({ status: 201, description: 'Adjustment ledger entry posted' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.settings.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async postAdjustment(
    @Param('wsId') wsId: string,
    @Body() dto: PostAdjustmentDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.ledgerService.postAdjustment(
      {
        workspaceId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(dto.teamMemberId),
        leaveTypeId: new Types.ObjectId(dto.leaveTypeId),
        year: dto.year,
      },
      dto.quantity,
      new Types.ObjectId(req.user.sub),
      dto.reason,
    );
    return { success: true, data };
  }

  /**
   * Teammates already on leave over a candidate date range — a non-blocking
   * warning surfaced before a member submits. For a self-scoped caller the
   * target member is resolved server-side; the query `memberId` is ignored.
   */
  @Get('conflicts')
  @ApiOperation({ summary: 'List teammates on leave over a candidate date range' })
  @ApiResponse({ status: 200, description: 'Non-blocking overlap warnings' })
  @ApiResponse({ status: 403, description: 'Caller has no team-directory record' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async conflicts(
    @Param('wsId') wsId: string,
    @Query() q: TeamConflictQuery,
    @Req() req: { user: { sub: string } },
  ) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectivePathScope(ctx, 'leave.request.view');
    const selfScoped = !ctx.isOwner && scope === 'self';

    let targetMemberId = q.memberId;
    if (selfScoped || !targetMemberId) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException('Your account has no team-directory record.');
      }
      targetMemberId = ctx.teamMemberId;
    }

    const data = await this.requestService.findTeamConflicts(wsId, targetMemberId, q.from, q.to);
    return { success: true, data };
  }

  /** Approved leave overlapping a date window — the team who's-on-leave calendar. */
  @Get('calendar')
  @ApiOperation({ summary: "Get approved leave for the team who's-on-leave calendar" })
  @ApiResponse({ status: 200, description: 'Approved leave overlapping the window' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'all')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async calendar(@Param('wsId') wsId: string, @Query() q: LeaveCalendarQuery) {
    const data = await this.requestService.listForCalendar(wsId, q.from, q.to);
    return { success: true, data };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get the workspace leave-request settings' })
  @ApiResponse({ status: 200, description: 'Approver chain, sandwich + retro policy' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.settings.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async getSettings(@Param('wsId') wsId: string) {
    const data = await this.settingsService.getSettings(wsId);
    return { success: true, data };
  }

  @Put('settings')
  @ApiOperation({ summary: 'Replace the workspace leave-request settings' })
  @ApiResponse({ status: 200, description: 'Updated leave settings' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.settings.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'configure' })
  async updateSettings(
    @Param('wsId') wsId: string,
    @Body() dto: UpdateLeaveSettingsDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.settingsService.updateSettings(wsId, dto, req.user.sub);
    return { success: true, data };
  }

  /**
   * Apply for leave. For a self-scoped caller the target member is resolved
   * from their own directory row — the body `memberId` is ignored, so a
   * Worker cannot apply on anyone else's behalf.
   */
  @Post('requests')
  @ApiOperation({ summary: 'Apply for leave' })
  @ApiResponse({ status: 201, description: 'Leave request created (pending or auto-approved)' })
  @ApiResponse({ status: 400, description: 'Invalid dates, payroll-locked, or quota exceeded' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.request.apply', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async apply(
    @Param('wsId') wsId: string,
    @Body() dto: ApplyLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectivePathScope(ctx, 'leave.request.apply');
    const selfScoped = !ctx.isOwner && scope === 'self';

    let memberId = dto.memberId;
    if (selfScoped || !memberId) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException(
          'Your account has no team-directory record, so leave cannot be applied for you.',
        );
      }
      memberId = ctx.teamMemberId;
    }

    const created = await this.requestService.applyForLeave({
      workspaceId: wsId,
      teamMemberId: memberId,
      appliedBy: req.user.sub,
      primaryLeaveTypeId: dto.leaveTypeId,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      firstDayHalf: dto.firstDayHalf ?? 'none',
      lastDayHalf: dto.lastDayHalf ?? 'none',
      reason: dto.reason,
      attachments: dto.attachments,
      selfScoped,
    });
    // Fire-and-forget — notify the L1 approver (or the member on auto-approve).
    void this.notificationService.leaveApplied(wsId, created);
    return { success: true, data: created };
  }

  /**
   * Dry-run the paid-vs-LWP decomposition for a candidate leave — powers the
   * self-service apply drawer's live preview. Nothing is persisted.
   */
  @Post('requests/preview')
  @ApiOperation({ summary: 'Dry-run the paid-vs-LWP decomposition for a candidate leave' })
  @ApiResponse({ status: 200, description: 'Preview breakdown — nothing persisted' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.request.apply', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async previewRequest(
    @Param('wsId') wsId: string,
    @Body() dto: ApplyLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectivePathScope(ctx, 'leave.request.apply');
    const selfScoped = !ctx.isOwner && scope === 'self';

    let memberId = dto.memberId;
    if (selfScoped || !memberId) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException('Your account has no team-directory record.');
      }
      memberId = ctx.teamMemberId;
    }

    const data = await this.requestService.previewLeave({
      workspaceId: wsId,
      teamMemberId: memberId,
      appliedBy: req.user.sub,
      primaryLeaveTypeId: dto.leaveTypeId,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      firstDayHalf: dto.firstDayHalf ?? 'none',
      lastDayHalf: dto.lastDayHalf ?? 'none',
    });
    return { success: true, data };
  }

  @Get('requests/mine')
  @ApiOperation({ summary: "List the caller's own leave requests" })
  @ApiResponse({ status: 200, description: "The caller's leave requests, newest first" })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async myRequests(@Param('wsId') wsId: string, @Req() req: { user: { sub: string } }) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    if (!ctx.teamMemberId) return { success: true, data: [] };
    const data = await this.requestService.listMyRequests(wsId, ctx.teamMemberId);
    return { success: true, data };
  }

  @Get('requests')
  @ApiOperation({ summary: 'List workspace leave requests (manager/HR queue)' })
  @ApiResponse({ status: 200, description: 'Leave requests, optionally filtered' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'all')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async list(@Param('wsId') wsId: string, @Query() q: ListLeaveRequestsQuery) {
    const data = await this.requestService.listForWorkspace(wsId, {
      status: q.status,
      teamMemberId: q.memberId,
    });
    return { success: true, data };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'Get a single leave request' })
  @ApiResponse({ status: 200, description: 'Leave request document' })
  @ApiResponse({ status: 404, description: 'Leave request not found' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'all')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async detail(@Param('wsId') wsId: string, @Param('id') id: string) {
    const data = await this.requestService.getRequest(wsId, id);
    return { success: true, data };
  }

  /** Approve the caller's current chain level. The service checks approver identity. */
  @Post('requests/:id/approve')
  @ApiOperation({ summary: "Approve the caller's current approval-chain level" })
  @ApiResponse({ status: 201, description: 'Chain advanced or request approved' })
  @ApiResponse({ status: 403, description: 'Caller is not the current-level approver' })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.approval.decide')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async approve(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.approveRequest(wsId, id, req.user.sub, dto.note);
    void this.notificationService.leaveDecided(wsId, data);
    return { success: true, data };
  }

  /** Reject the caller's current chain level — terminal. */
  @Post('requests/:id/reject')
  @ApiOperation({ summary: "Reject the caller's current approval-chain level (terminal)" })
  @ApiResponse({ status: 201, description: 'Request rejected' })
  @ApiResponse({ status: 403, description: 'Caller is not the current-level approver' })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.approval.decide')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async reject(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.rejectRequest(wsId, id, req.user.sub, dto.note);
    void this.notificationService.leaveDecided(wsId, data);
    return { success: true, data };
  }

  /** Applicant cancels their own still-pending request. */
  @Post('requests/:id/cancel')
  @ApiOperation({ summary: "Cancel the caller's own still-pending leave request" })
  @ApiResponse({ status: 201, description: 'Request cancelled' })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the applicant, or it is already actioned',
  })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.request.cancel', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async cancel(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.cancelRequest(wsId, id, req.user.sub);
    void this.notificationService.leaveClosed(wsId, data);
    return { success: true, data };
  }

  /** Applicant withdraws their own already-approved request. */
  @Post('requests/:id/withdraw')
  @ApiOperation({ summary: "Withdraw the caller's own already-approved leave request" })
  @ApiResponse({ status: 201, description: 'Request withdrawn; ledger + attendance reversed' })
  @ApiResponse({ status: 403, description: 'Caller is not the applicant' })
  @ApiResponse({ status: 409, description: 'Request is not in an approved state' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.request.cancel', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async withdraw(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.withdrawRequest(wsId, id, req.user.sub);
    void this.notificationService.leaveClosed(wsId, data);
    return { success: true, data };
  }
}
