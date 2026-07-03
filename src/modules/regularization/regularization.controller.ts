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
import { RegularizationService } from './regularization.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule } from '../../common/enums/modules.enum';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import {
  CreateRegularizationDto,
  DecideRegularizationDto,
  ListRegularizationsQuery,
} from './dto/regularization.dto';

/**
 * Regularization routes — Access Control Initiative §8 Part B2 scope split:
 *
 *   - `create` / `my-requests` / `cancel` → `manage_regularizations` at
 *     `'self'` scope. Admits a self-scoped Worker (own correction requests)
 *     and an `'all'`-scoped Manager/HR (`'all'` is a superset of `'self'`).
 *   - `pending-for-me` / `list` / `:id` / `approve` / `reject` → `'all'`
 *     scope. These are the manager/approver surface — a self-scoped Worker
 *     is denied; they never see the org-wide queue or decide requests.
 */
@Controller('workspaces/:wsId/regularizations')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class RegularizationController {
  constructor(
    private readonly service: RegularizationService,
    private readonly callerScope: CallerScopeService,
  ) {}

  /**
   * Raise a regularization request. For a self-scoped caller the target
   * member is resolved server-side from their own directory row — the body
   * `memberId` is ignored, so a Worker cannot raise a correction against
   * anyone else. The workspace `selfServiceConfig.selfLeaveApply` policy
   * gate for self-scoped raisers is enforced in the service.
   */
  @Post()
  @RequirePermission('regularization.request.apply', 'self')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'request' })
  async create(@Param('wsId') wsId: string, @Body() dto: CreateRegularizationDto, @Req() req: any) {
    const ctx = await this.callerScope.resolve(wsId, req.user.sub);
    const scope = this.callerScope.effectivePathScope(ctx, 'regularization.request.apply');
    const selfScoped = !ctx.isOwner && scope === 'self';

    let memberId = dto.memberId;
    if (selfScoped) {
      if (!ctx.teamMemberId) {
        throw new ForbiddenException(
          'Your account has no team-directory record, so a correction request cannot be raised for you.',
        );
      }
      // Self-scoped raisers may only target their OWN directory row.
      memberId = ctx.teamMemberId;
    }

    const created = await this.service.create({
      wsId,
      raisedBy: req.user.sub,
      memberId,
      date: dto.date,
      requestedStatus: dto.requestedStatus,
      requestedCheckIn: dto.requestedCheckIn,
      requestedCheckOut: dto.requestedCheckOut,
      reason: dto.reason,
      reasonCategory: dto.reasonCategory,
      attachments: dto.attachments,
      selfScoped,
    });
    // Fire-and-forget notifications — dispatched to current L1 approver
    this.service.notifyNewApprover(wsId, created).catch(() => {});
    return { success: true, data: created };
  }

  @Get('pending-for-me')
  @RequirePermission('regularization.approval.decide')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'approve' })
  async pendingForMe(@Param('wsId') wsId: string, @Req() req: any) {
    const items = await this.service.findPendingForUser(wsId, req.user.sub);
    return { success: true, data: items };
  }

  @Get('my-requests')
  @RequirePermission('regularization.request.view', 'self')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'request' })
  async myRequests(@Param('wsId') wsId: string, @Req() req: any) {
    const items = await this.service.findMyRequests(wsId, req.user.sub);
    return { success: true, data: items };
  }

  @Get()
  @RequirePermission('regularization.request.view', 'all')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'view_audit' })
  async list(@Param('wsId') wsId: string, @Query() q: ListRegularizationsQuery) {
    const items = await this.service.findAll(wsId, q);
    return { success: true, data: items };
  }

  @Get(':id')
  @RequirePermission('regularization.request.view', 'all')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'view_audit' })
  async detail(@Param('wsId') wsId: string, @Param('id') id: string) {
    const doc = await this.service.findOne(wsId, id);
    return { success: true, data: doc };
  }

  @Post(':id/approve')
  @RequirePermission('regularization.approval.decide')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'approve' })
  async approve(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideRegularizationDto,
    @Req() req: any,
  ) {
    const updated = await this.service.approveStep(wsId, id, req.user.sub, dto.note);
    // Post-approval fan-out — service method decides based on isFinal
    this.service.notifyAfterApproval(wsId, updated).catch(() => {});
    return { success: true, data: updated };
  }

  @Post(':id/reject')
  @RequirePermission('regularization.approval.decide')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'reject' })
  async reject(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: DecideRegularizationDto,
    @Req() req: any,
  ) {
    const updated = await this.service.reject(wsId, id, req.user.sub, dto.note);
    this.service.notifyRejection(wsId, updated).catch(() => {});
    return { success: true, data: updated };
  }

  @Post(':id/cancel')
  @RequirePermission('regularization.request.cancel', 'self')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'request' })
  async cancel(@Param('wsId') wsId: string, @Param('id') id: string, @Req() req: any) {
    const updated = await this.service.cancel(wsId, id, req.user.sub);
    this.service.notifyCancellation(wsId, updated).catch(() => {});
    return { success: true, data: updated };
  }
}
