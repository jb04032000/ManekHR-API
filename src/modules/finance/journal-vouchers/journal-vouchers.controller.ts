import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JournalVouchersService } from './journal-vouchers.service';
import { CreateJournalVoucherDto } from './dto/create-journal-voucher.dto';
import { ListJournalVouchersDto } from './dto/list-journal-vouchers.dto';

@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/journal-vouchers')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_journal_entries' })
export class JournalVouchersController {
  constructor(private readonly service: JournalVouchersService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/journal-vouchers — create draft JV */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateJournalVoucherDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(wsId, firmId, dto, user._id ?? user.sub);
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/journal-vouchers — list with filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListJournalVouchersDto,
  ) {
    return this.service.list(wsId, firmId, query);
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/journal-vouchers/:id — single JV */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findById(wsId, firmId, id);
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/journal-vouchers/:id/post — post draft */
  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.post(wsId, firmId, id, user._id ?? user.sub);
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/journal-vouchers/:id/cancel — cancel posted */
  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(wsId, firmId, id, user._id ?? user.sub, body?.reason);
  }
}
