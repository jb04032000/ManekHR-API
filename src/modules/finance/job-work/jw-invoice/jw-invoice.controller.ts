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
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { JwInvoiceService } from './jw-invoice.service';
import { CreateJwInvoiceDto } from './dto/create-jw-invoice.dto';
import { UpdateJwInvoiceDto } from './dto/update-jw-invoice.dto';
import { ListJwInvoiceDto } from './dto/list-jw-invoice.dto';

/**
 * JwInvoiceController
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/jw/invoices
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: AppModule.FINANCE subFeature 'job_work' (D-15 Pro+ gate).
 *
 * Permission mapping (finance billing path-RBAC, design spec 2026-06-01 SS6.B):
 *   List / Get  → 'finance.invoice.view' (self)
 *   Create      → 'finance.invoice.create' (self)
 *   Update / Cancel → 'finance.invoice.edit' (self)
 *   Post        → 'finance.invoice.post' (self)
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/jw/invoices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.JOB_WORK, subFeature: 'invoicing' })
export class JwInvoiceController {
  constructor(private readonly service: JwInvoiceService) {}

  @Get()
  @RequirePermission('finance.invoice.view', 'self')
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() q: ListJwInvoiceDto,
  ) {
    const data = await this.service.list(wsId, firmId, q);
    return { success: true, data };
  }

  @Post()
  @RequirePermission('finance.invoice.create', 'self')
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Req() req: any,
    @Body() dto: CreateJwInvoiceDto,
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
  @RequirePermission('finance.invoice.view', 'self')
  async get(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    const data = await this.service.get(wsId, firmId, id);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermission('finance.invoice.edit', 'self')
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateJwInvoiceDto,
  ) {
    const data = await this.service.update(wsId, firmId, id, dto);
    return { success: true, data };
  }

  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('finance.invoice.post', 'self')
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
  @RequirePermission('finance.invoice.edit', 'self')
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const data = await this.service.cancel(
      wsId,
      firmId,
      id,
      req.user._id ?? req.user.sub ?? req.user.id,
    );
    return { success: true, data };
  }
}
