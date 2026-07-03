import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { CustomPlanRequestsService } from './custom-plan-requests.service';
import {
  AdminListCustomPlanRequestsQueryDto,
  AdminUpdateCustomPlanRequestDto,
  CreateCustomPlanRequestDto,
  CreatePlanInterestRequestDto,
} from './dto/custom-plan-request.dto';

/**
 * User-facing: submit a custom-plan lead from the in-app Plans hub.
 * Mirrors SubscriptionsController's write pattern (JwtAuthGuard + req.user.sub).
 * @LegacyUnclassified satisfies the global fail-closed RolesGuard (an authed user
 * is sufficient; no workspace RBAC permission) - same as every subscriptions/
 * billing controller. Without it the RolesGuard 403s "no permission".
 */
@LegacyUnclassified()
@Controller('subscriptions/custom-plan-request')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class CustomPlanRequestsController {
  constructor(private readonly service: CustomPlanRequestsService) {}

  @Post()
  create(@Req() req: { user: { sub: string } }, @Body() dto: CreateCustomPlanRequestDto) {
    return this.service.create(req.user.sub, dto);
  }

  // Plan-interest lead: a Subscribe click on a predefined paid plan while online
  // payments are off. Lands in the same collection as the custom lead (kind='plan')
  // so the admin sees both together. Consumed by the FE PlanContactModal.
  @Post('plan-interest')
  createPlanInterest(
    @Req() req: { user: { sub: string } },
    @Body() dto: CreatePlanInterestRequestDto,
  ) {
    return this.service.createPlanInterest(req.user.sub, dto);
  }
}

/**
 * Admin-facing: triage queue + status updates. Mirrors AdminPlanController's
 * guard stack (JwtAuthGuard + IsAdminGuard + ThrottlerGuard). @LegacyUnclassified
 * satisfies the global RolesGuard; IsAdminGuard still enforces admin-only.
 */
@LegacyUnclassified()
@Controller('admin/custom-plan-requests')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class AdminCustomPlanRequestsController {
  constructor(private readonly service: CustomPlanRequestsService) {}

  @Get()
  list(@Query() query: AdminListCustomPlanRequestsQueryDto) {
    return this.service.adminList({
      status: query.status,
      kind: query.kind,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Patch(':id')
  update(
    @Req() req: { user: { sub: string } },
    @Param('id') id: string,
    @Body() dto: AdminUpdateCustomPlanRequestDto,
  ) {
    return this.service.adminUpdate(id, req.user.sub, dto);
  }
}
