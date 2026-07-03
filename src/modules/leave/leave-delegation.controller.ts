import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { LeaveDelegationService } from './leave-delegation.service';
import { CreateDelegationDto, ListDelegationsQuery } from './dto/leave.dto';

/**
 * Approver-delegation routes — Leave epic L3c3. An approver delegates their
 * own approval authority for a window; the gate is `approve_leave` / `all`
 * (you must be an approver to delegate). A delegation always delegates the
 * *caller's* authority — `fromUserId` is the authenticated user.
 */
@ApiTags('Leave')
@Controller('workspaces/:wsId/leave/delegations')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class LeaveDelegationController {
  constructor(private readonly delegationService: LeaveDelegationService) {}

  /** Delegate the caller's approval authority for a coverage window. */
  @Post()
  @ApiOperation({ summary: "Delegate the caller's approval authority for a coverage window" })
  @ApiResponse({ status: 201, description: 'Delegation created' })
  @ApiResponse({ status: 400, description: 'Invalid dates or self-delegation' })
  @ApiResponse({
    status: 409,
    description: 'An active delegation already covers part of the window',
  })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.delegation.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async create(
    @Param('wsId') wsId: string,
    @Body() dto: CreateDelegationDto,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.delegationService.createDelegation({
      workspaceId: wsId,
      fromUserId: req.user.sub,
      toUserId: dto.toUserId,
      startsOn: dto.startsOn,
      endsOn: dto.endsOn,
      reason: dto.reason,
    });
    return { success: true, data };
  }

  /** Workspace delegation roster — active-only unless `includeInactive=true`. */
  @Get()
  @ApiOperation({ summary: 'List the workspace approver-delegation roster' })
  @ApiResponse({ status: 200, description: 'Delegations — active-only unless includeInactive' })
  @Throttle({ 'leave-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('leave.delegation.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async list(@Param('wsId') wsId: string, @Query() q: ListDelegationsQuery) {
    const data = await this.delegationService.listDelegations(wsId, {
      fromUserId: q.fromUserId,
      includeInactive: q.includeInactive === 'true',
    });
    return { success: true, data };
  }

  /** Revoke a delegation — only the delegating approver may do so. */
  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke a delegation (delegating approver only)' })
  @ApiResponse({ status: 201, description: 'Delegation revoked' })
  @ApiResponse({ status: 403, description: 'Caller is not the delegating approver' })
  @ApiResponse({ status: 404, description: 'Delegation not found' })
  @ApiResponse({ status: 409, description: 'Delegation is already revoked' })
  @Throttle({ 'leave-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('leave.delegation.manage')
  @RequireSubscription({ module: AppModule.LEAVE, subFeature: 'approve' })
  async revoke(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
  ) {
    const data = await this.delegationService.revokeDelegation(wsId, id, req.user.sub);
    return { success: true, data };
  }
}
