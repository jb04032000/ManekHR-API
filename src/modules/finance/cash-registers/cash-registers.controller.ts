import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CashRegistersService } from './cash-registers.service';
import { CreateCashRegisterDto } from './dto/create-cash-register.dto';
import { DayEndTallyDto } from './dto/day-end-tally.dto';
import { ReplenishPettyCashDto } from './dto/replenish-petty-cash.dto';

@ApiTags('Finance - Banking')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/cash-registers')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_cash_registers' })
export class CashRegistersController {
  constructor(private readonly cashRegistersService: CashRegistersService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.cashRegistersService.findAll(wsId, firmId);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateCashRegisterDto,
  ) {
    return this.cashRegistersService.create(wsId, firmId, dto);
  }

  /** GET .../cash-registers/low-water-alerts — must be before :id to avoid route conflict */
  @Get('low-water-alerts')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  lowWaterAlerts(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.cashRegistersService.lowWaterAlert(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
    );
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.cashRegistersService.findOne(wsId, firmId, id);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: Partial<CreateCashRegisterDto>,
  ) {
    return this.cashRegistersService.update(wsId, firmId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  remove(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.cashRegistersService.remove(wsId, firmId, id);
  }

  /** POST .../cash-registers/:id/day-end-tally — day-end denomination tally (T-F06W3-04) */
  @Post(':id/day-end-tally')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  dayEndTally(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: DayEndTallyDto,
    @CurrentUser() user: any,
  ) {
    return this.cashRegistersService.dayEndTally(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
      dto,
      user._id ?? user.sub,
    );
  }

  /** POST .../cash-registers/:id/replenish — petty cash replenishment via contra */
  @Post(':id/replenish')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  replenish(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: ReplenishPettyCashDto,
    @CurrentUser() user: any,
  ) {
    return this.cashRegistersService.replenishPettyCash(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(id),
      dto,
      user._id ?? user.sub,
    );
  }
}
