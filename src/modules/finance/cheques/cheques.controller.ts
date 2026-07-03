import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ChequesService } from './cheques.service';
import { CreateChequeDto } from './dto/create-cheque.dto';
import { ListChequesDto } from './dto/list-cheques.dto';
import {
  DepositChequeDto,
  ClearChequeDto,
  BounceChequeDto,
  StopChequePaidDto,
} from './dto/cheque-action.dto';

/**
 * ChequesController
 *
 * Route prefix: /workspaces/:wsId/finance/firms/:firmId/cheques
 *
 * Endpoints:
 *   POST   /                     — register a new cheque
 *   GET    /                     — list cheques (filter by type, status, date range)
 *   GET    /:id                  — single cheque detail
 *   POST   /:id/deposit          — received: pending_maturity → in_transit
 *   POST   /:id/clear            — issued/received: → cleared (posts ledger entry)
 *   POST   /:id/bounce           — → bounced (posts reversal + bounce charges)
 *   POST   /:id/stop             — issued: → stopped (stop payment instruction)
 *   POST   /:id/void             — → void (data entry error)
 */
@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/cheques')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'banking_cheques' })
export class ChequesController {
  constructor(private readonly service: ChequesService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateChequeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListChequesDto,
  ) {
    return this.service.list(new Types.ObjectId(wsId), new Types.ObjectId(firmId), query);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findById(new Types.ObjectId(wsId), new Types.ObjectId(firmId), id);
  }

  /** Received cheque: pending_maturity → in_transit */
  @Post(':id/deposit')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  deposit(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: DepositChequeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.deposit(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /** Clear cheque — posts ledger entry and updates bank balance */
  @Post(':id/clear')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  clear(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: ClearChequeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.clear(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /** Bounce cheque — reversal + optional bounce charges */
  @Post(':id/bounce')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  bounce(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: BounceChequeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.bounce(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /** Stop payment — issued cheque only */
  @Post(':id/stop')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  stop(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: StopChequePaidDto,
    @CurrentUser() user: any,
  ) {
    return this.service.stop(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /** Void cheque — data entry error */
  @Post(':id/void')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  voidCheque(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.void(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
  }
}
