import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { JwInwardChallanService } from './jw-inward-challan.service';
import { CreateJwInwardDto } from './dto/create-jw-inward.dto';
import { UpdateJwInwardDto } from './dto/update-jw-inward.dto';
import { ListJwInwardDto } from './dto/list-jw-inward.dto';

/**
 * JwInwardChallanController
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/jw/inward-challans
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: AppModule.FINANCE subFeature 'job_work' (D-15 Pro+ gate).
 *
 * Permission mapping (D-14):
 *   List / Get  → 'view_reports'
 *   Create / Update / Post / Cancel → 'manage_job_work_in'
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/jw/inward-challans')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.JOB_WORK, subFeature: 'inward' })
export class JwInwardChallanController {
  constructor(private readonly service: JwInwardChallanService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() q: ListJwInwardDto,
  ) {
    const data = await this.service.list(wsId, firmId, q);
    return { success: true, data };
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, 'manage_job_work_in' as any)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Req() req: any,
    @Body() dto: CreateJwInwardDto,
  ) {
    const data = await this.service.create(
      wsId,
      firmId,
      req.user._id ?? req.user.sub ?? req.user.id,
      dto,
    );
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async get(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    const data = await this.service.get(wsId, firmId, id);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, 'manage_job_work_in' as any)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateJwInwardDto,
  ) {
    const data = await this.service.update(wsId, firmId, id, dto);
    return { success: true, data };
  }

  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_job_work_in' as any)
  async post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const data = await this.service.post(
      wsId,
      firmId,
      id,
      req.user._id ?? req.user.sub ?? req.user.id,
    );
    return { success: true, data };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_job_work_in' as any)
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    const data = await this.service.cancel(wsId, firmId, id);
    return { success: true, data };
  }
}
