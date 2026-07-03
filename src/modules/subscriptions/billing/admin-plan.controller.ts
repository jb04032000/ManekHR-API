import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { AdminPlanService } from './services/admin-plan.service';
import {
  AdminCreateCustomPlanDto,
  AdminCustomPlanListQueryDto,
  AdminUpdateCustomPlanDto,
} from './dto/admin-billing.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Custom-plan CRUD (D1i). Plans created here have `isCustom=true` and
 * are bound to a single user OR workspace. Catalogue plans (the
 * public pricing page) are managed elsewhere — this controller
 * intentionally rejects updates to non-custom plans.
 */
@LegacyUnclassified()
@Controller('admin/billing/plans')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class AdminPlanController {
  constructor(private readonly plans: AdminPlanService) {}

  @Post()
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  create(@Req() req: any, @Body() dto: AdminCreateCustomPlanDto) {
    return this.plans.createCustomPlan({
      ...dto,
      adminUserId: req.user.sub,
    });
  }

  @Get()
  list(@Query() query: AdminCustomPlanListQueryDto) {
    return this.plans.listCustomPlans({
      assignedUserId: query.assignedUserId,
      assignedWorkspaceId: query.assignedWorkspaceId,
      isActive: query.isActive,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  fetch(@Param('id') id: string) {
    return this.plans.fetchCustomPlan(id);
  }

  @Patch(':id')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  update(@Req() req: any, @Param('id') id: string, @Body() dto: AdminUpdateCustomPlanDto) {
    return this.plans.updateCustomPlan(id, dto, req.user.sub);
  }

  @Delete(':id')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  archive(@Req() req: any, @Param('id') id: string) {
    return this.plans.archiveCustomPlan(id, req.user.sub);
  }
}
