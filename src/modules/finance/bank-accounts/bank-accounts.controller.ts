import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { ParseObjectIdPipe } from '../../../common/pipes/parse-object-id.pipe';
import { BankAccountsService } from './bank-accounts.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { ListBankAccountsDto } from './dto/list-bank-accounts.dto';
import { GetStatementDto } from './dto/get-statement.dto';

/**
 * BankAccountsController
 *
 * Route prefix: /workspaces/:wsId/finance/firms/:firmId/bank-accounts
 *
 * Endpoints:
 *   POST   /                   — create bank account
 *   GET    /                   — list bank accounts (with optional filters)
 *   GET    /default            — get default bank account
 *   GET    /:id                — single bank account (account number masked)
 *   GET    /:id/statement        — paginated ledger statement with running balance
 *   PATCH  /:id                — update bank account metadata
 *   DELETE /:id                — soft-delete bank account (requires zero balance)
 */
@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/bank-accounts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'banking_bank_accounts' })
export class BankAccountsController {
  constructor(private readonly service: BankAccountsService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.service.create(wsId, firmId, dto);
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Query() query: ListBankAccountsDto,
  ) {
    return this.service.findAll(wsId, firmId, query);
  }

  /** GET /default — must be before /:id to avoid routing conflict */
  @Get('default')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getDefault(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
  ) {
    return this.service.findDefault(wsId, firmId);
  }

  /** GET /:id/statement — must be before /:id to avoid routing conflict */
  @Get(':id/statement')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getStatement(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Query() query: GetStatementDto,
  ) {
    return this.service.getStatement(wsId, firmId, id.toString(), query);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
  ) {
    return this.service.findById(wsId, firmId, id.toString());
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.service.update(wsId, firmId, id.toString(), dto);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  softDelete(
    @Param('wsId', ParseObjectIdPipe) wsId: Types.ObjectId,
    @Param('firmId', ParseObjectIdPipe) firmId: Types.ObjectId,
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
  ) {
    return this.service.softDelete(wsId, firmId, id.toString());
  }
}
