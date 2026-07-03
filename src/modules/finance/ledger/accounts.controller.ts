import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';

@ApiTags('Finance - Ledger')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/accounts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_coa' })
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    return this.accountsService.findAll(wsId, firmId, includeDeleted === 'true');
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateAccountDto,
  ) {
    return this.accountsService.create(wsId, firmId, dto);
  }

  @Patch(':accountId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('accountId') accountId: string,
    @Body() dto: Partial<CreateAccountDto>,
  ) {
    return this.accountsService.update(wsId, firmId, accountId, dto);
  }

  @Delete(':accountId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  remove(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.accountsService.remove(wsId, firmId, accountId);
  }
}
