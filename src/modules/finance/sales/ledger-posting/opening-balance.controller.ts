import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { OpeningBalanceService } from './opening-balance.service';
import { SetOpeningBalanceDto } from './dto/opening-balance.dto';

// PATCH .../accounts/:accountId/opening-balance — set/replace a ledger's opening
// balance. Separate from AccountsController (ledger module) because the posting
// path needs LedgerPostingService, which would create a circular module
// dependency if injected there. Same guard stack + FINANCE.EDIT as account edits;
// the path-prefix matches AccountsController but the sub-path differs so routes
// do not clash.
@ApiTags('Finance - Ledger')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/accounts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_coa' })
export class OpeningBalanceController {
  constructor(private readonly service: OpeningBalanceService) {}

  @Patch(':accountId/opening-balance')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  setOpeningBalance(
    @Param('workspaceId') workspaceId: string,
    @Param('firmId') firmId: string,
    @Param('accountId') accountId: string,
    @Body() dto: SetOpeningBalanceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.setOpeningBalance(
      workspaceId,
      firmId,
      accountId,
      dto,
      user._id ?? user.sub,
    );
  }
}
