import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { VoucherSeriesService } from './voucher-series.service';
import { CreateVoucherSeriesDto } from './dto/create-voucher-series.dto';
import { UpdateVoucherSeriesDto } from './dto/update-voucher-series.dto';

@ApiTags('Finance - Settings')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/voucher-series')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_voucher_series' })
export class VoucherSeriesController {
  constructor(private readonly vsService: VoucherSeriesService) {}

  // GET all series for the settings page — gated by finance.settings.manage
  // so only Owner/HR can reach the numbering editor, consistent with the
  // branding endpoint pattern.
  @Get()
  @RequirePermission('finance.settings.manage')
  findAll(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.vsService.findAll(wsId, firmId);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateVoucherSeriesDto,
  ) {
    return this.vsService.create(wsId, firmId, dto);
  }

  // PATCH /:id — custom invoice numbering editor (2026-06-01).
  // Accepts UpdateVoucherSeriesDto (prefix / padDigits / startNumber).
  // Gated by finance.settings.manage (Owner/HR only by preset), mirroring
  // the branding endpoint on FirmsController.
  @Patch(':id')
  @RequirePermission('finance.settings.manage')
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateVoucherSeriesDto,
  ) {
    return this.vsService.update(wsId, firmId, id, dto);
  }

  @Get(':voucherType/next')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getNextNumber(
    @Param('firmId') firmId: string,
    @Param('voucherType') voucherType: string,
    @Query('financialYear') financialYear: string,
  ) {
    return this.vsService.generateNextNumber(firmId, voucherType, financialYear);
  }
}
