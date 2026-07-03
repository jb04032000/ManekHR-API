import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ApiTags } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { CreateExpenseVoucherDto } from './dto/create-expense-voucher.dto';
import { UpdateExpenseVoucherDto } from './dto/update-expense-voucher.dto';
import { ListExpenseVouchersDto } from './dto/list-expense-vouchers.dto';

@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/expenses')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_expenses' })
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/expenses — create draft */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateExpenseVoucherDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/expenses — list with filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListExpenseVouchersDto,
  ) {
    return this.service.list(new Types.ObjectId(wsId), new Types.ObjectId(firmId), query);
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/expenses/:id — single */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findById(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
    );
  }

  /** PATCH /workspaces/:wsId/finance/firms/:firmId/expenses/:id — update draft */
  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseVoucherDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
      dto,
      user._id ?? user.sub,
    );
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/expenses/:id/post — post voucher */
  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.post(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
      user._id ?? user.sub,
    );
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/expenses/:id/cancel — cancel posted */
  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
      user._id ?? user.sub,
      body?.reason,
    );
  }
}
