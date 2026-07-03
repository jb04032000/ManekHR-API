import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { PartyLedgerService } from './party-ledger.service';

@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'payments_party_ledger' })
export class PartyLedgerController {
  constructor(private readonly partyLedgerService: PartyLedgerService) {}

  @Get('parties/:partyId/ledger')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPartyLedger(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.partyLedgerService.getPartyLedger(wsId, firmId, partyId, {
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    });
  }

  @Get('parties/:partyId/outstanding-invoices')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getOutstandingInvoices(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
  ) {
    return this.partyLedgerService.getOutstandingInvoicesForParty(wsId, firmId, partyId);
  }

  @Get('receivables/aging')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getAgingBuckets(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.partyLedgerService.getAgingBuckets(wsId, firmId);
  }

  @Get('receivables/summary')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getReceivablesSummary(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.partyLedgerService.getReceivablesSummary(wsId, firmId);
  }
}
