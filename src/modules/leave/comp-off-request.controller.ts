import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { CompOffRequestService } from './comp-off-request.service';
import { LeaveNotificationService } from './leave-notification.service';
import { ApplyCompOffDto, DecideLeaveDto, ListLeaveRequestsQuery } from './dto/leave.dto';

/**
 * Comp-off earning routes — Leave epic L3c1. A member claims they worked a
 * holiday / weekly-off; approval mints a comp-off lot.
 *
 * Scope split mirrors `LeaveController`: apply / `mine` are `'self'` (a
 * self-scoped Worker claims for themselves only); list / detail / decide are
 * `'all'` (the manager / HR queue).
 */
@ApiTags('Leave')
@Controller('workspaces/:wsId/leave/comp-off-requests')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class CompOffRequestController {
  constructor(
    private readonly requestService: CompOffRequestService,
    private readonly callerScope: CallerScopeService,
    private readonly notificationService: LeaveNotificationService,
  ) {}

  /**
   * Claim comp-off. For a self-scoped caller the target member is resolved
   * from their own directory row — the body `memberId` is ignored.
   */
  @Post()
  @ApiOperation({ summary: 'Claim comp-off for a worked holiday / weekly-off' })
  @ApiResponse({ status: 201, description: 'Comp-off request created (pending or auto-approved)' })
  @ApiResponse({
    status: 400,
    description: 'Day is not comp-off-earnable, or outside the retro window',
  })
  @ApiResponse({ status: 409, description: 'A live comp-off claim for this date already exists' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.compOff.apply', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async apply(
    @Param('wsId') wsId: string,
    @Body() dto: ApplyCompOffDto,
    @Req() req: { user: { sub: string } },
  ) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectiveScope(ctx, AppModule.LEAVE, ModuleAction.APPLY_LEAVE);
    const selfScoped = !ctx.isOwner && scope === 'self';

    let memberId = dto.memberId;
    if (selfScoped || !memberId) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException(
          'Your account has no team-directory record, so comp-off cannot be claimed for you.',
        );
      }
      memberId = ctx.teamMemberId;
    }

    const data = await this.requestService.applyForCompOff({
      workspaceId: wsId,
      teamMemberId: memberId,
      appliedBy: req.user.sub,
      workDate: dto.workDate,
      quantity: dto.quantity,
      reason: dto.reason,
      attachments: dto.attachments,
      selfScoped,
    });
    // Fire-and-forget — notify the L1 approver (or the member on auto-approve).
    void this.notificationService.compOffApplied(wsId, data);
    return { success: true, data };
  }

  @Get('mine')
  @ApiOperation({ summary: "List the caller's own comp-off requests" })
  @ApiResponse({ status: 200, description: "The caller's comp-off requests, newest first" })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async mine(@Param('wsId') wsId: string, @Req() req: { user: { sub: string } }) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    if (!ctx.teamMemberId) return { success: true, data: [] };
    const data = await this.requestService.listMyRequests(wsId, ctx.teamMemberId);
    return { success: true, data };
  }

  /** The caller's own active comp-off lots (non-expired, unspent) — L6b. */
  @Get('lots')
  @ApiOperation({ summary: "List the caller's active (non-expired, unspent) comp-off lots" })
  @ApiResponse({ status: 200, description: "The caller's active comp-off lots" })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async lots(@Param('wsId') wsId: string, @Req() req: { user: { sub: string } }) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    if (!ctx.teamMemberId) return { success: true, data: [] };
    const data = await this.requestService.listMyLots(wsId, ctx.teamMemberId);
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'List workspace comp-off requests (manager/HR queue)' })
  @ApiResponse({ status: 200, description: 'Comp-off requests, optionally filtered' })
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

  @Get(':id')
  @ApiOperation({ summary: 'Get a single comp-off request' })
  @ApiResponse({ status: 200, description: 'Comp-off request document' })
  @ApiResponse({ status: 404, description: 'Comp-off request not found' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.request.view', 'all')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'view_balance' })
  async detail(@Param('wsId') wsId: string, @Param('id') id: string) {
    const data = await this.requestService.getRequest(wsId, id);
    return { success: true, data };
  }

  /** Approve the caller's current chain level — the service checks approver identity. */
  @Post(':id/approve')
  @ApiOperation({ summary: "Approve the caller's current comp-off approval-chain level" })
  @ApiResponse({ status: 201, description: 'Chain advanced or comp-off lot minted' })
  @ApiResponse({ status: 403, description: 'Caller is not the current-level approver' })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.compOff.decide')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async approve(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.approveRequest(wsId, id, req.user.sub, dto.note);
    void this.notificationService.compOffDecided(wsId, data);
    return { success: true, data };
  }

  /** Reject the caller's current chain level — terminal. */
  @Post(':id/reject')
  @ApiOperation({ summary: "Reject the caller's current comp-off approval-chain level (terminal)" })
  @ApiResponse({ status: 201, description: 'Comp-off request rejected' })
  @ApiResponse({ status: 403, description: 'Caller is not the current-level approver' })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.compOff.decide')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async reject(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.rejectRequest(wsId, id, req.user.sub, dto.note);
    void this.notificationService.compOffDecided(wsId, data);
    return { success: true, data };
  }

  /** Applicant cancels their own still-pending claim. */
  @Post(':id/cancel')
  @ApiOperation({ summary: "Cancel the caller's own still-pending comp-off claim" })
  @ApiResponse({ status: 201, description: 'Comp-off claim cancelled' })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the applicant, or it is already actioned',
  })
  @ApiResponse({ status: 409, description: 'Request is no longer pending' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.compOff.apply', 'self')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'apply' })
  async cancel(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.requestService.cancelRequest(wsId, id, req.user.sub);
    void this.notificationService.compOffClosed(wsId, data);
    return { success: true, data };
  }
}
