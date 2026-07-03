import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ConvertVoucherService } from './convert-voucher.service';
import { ConvertVoucherDto } from './dto/convert-voucher.dto';

/**
 * ConvertVoucherController — D-04 multi-doc combine endpoint.
 *
 * POST /workspaces/:wsId/finance/firms/:firmId/sales/convert
 * Body: { sourceType, sourceIds[], targetType }
 */
@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/finance/firms/:firmId/sales/convert')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_invoicing' })
export class ConvertVoucherController {
  constructor(private readonly service: ConvertVoucherService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  convert(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ConvertVoucherDto,
    @CurrentUser() user: any,
  ) {
    return this.service.convert(wsId, firmId, dto, user._id ?? user.sub);
  }
}
