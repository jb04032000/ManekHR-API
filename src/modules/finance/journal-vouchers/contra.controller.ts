import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ContraService } from './contra.service';
import { CreateContraVoucherDto } from './dto/create-contra-voucher.dto';
import { ListJournalVouchersDto } from './dto/list-journal-vouchers.dto';

@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/contras')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_contra_entries' })
export class ContraController {
  constructor(private readonly service: ContraService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/contras — create-and-post contra voucher */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  createAndPost(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateContraVoucherDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createAndPost(wsId, firmId, dto, user._id ?? user.sub);
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/contras — list contra vouchers */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListJournalVouchersDto,
  ) {
    return this.service.list(wsId, firmId, query);
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/contras/:id — single contra voucher */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findById(wsId, firmId, id);
  }
}
