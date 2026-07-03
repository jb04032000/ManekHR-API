import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { ImportService } from './import.service';
import { ImportRowsDto } from './dto/import-rows.dto';

// D19 onboarding import. Tenant-scoped + RBAC-gated; reuses the parties_master subscription
// sub-feature. Entities: parties, opening balances (item masters + pending invoices to follow).
// Every entity is validate (dry-run) then commit.
@ApiTags('Finance - Import')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/import')
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'parties_master' })
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  // ── parties ──
  @Post('parties/validate')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  validateParties(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.validateParties(wsId, firmId, dto.rows);
  }

  @Post('parties/commit')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  commitParties(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.commitParties(wsId, firmId, dto.rows);
  }

  // ── opening balances ── (commit posts ledger entries, so it needs EDIT like the OB endpoint)
  @Post('opening-balances/validate')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  validateOpeningBalances(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.validateOpeningBalances(wsId, firmId, dto.rows);
  }

  @Post('opening-balances/commit')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  commitOpeningBalances(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
    @CurrentUser() user: { _id?: string; sub?: string },
  ) {
    return this.importService.commitOpeningBalances(
      wsId,
      firmId,
      dto.rows,
      user._id ?? user.sub ?? '',
    );
  }

  // ── item masters ──
  @Post('items/validate')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  validateItems(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.validateItems(wsId, firmId, dto.rows);
  }

  @Post('items/commit')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  commitItems(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.commitItems(wsId, firmId, dto.rows);
  }

  // ── pending invoices (bill-wise opening AR) ── (commit posts ledger entries -> EDIT + userId)
  @Post('pending-invoices/validate')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  validatePendingInvoices(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.importService.validatePendingInvoices(wsId, firmId, dto.rows);
  }

  @Post('pending-invoices/commit')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  commitPendingInvoices(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ImportRowsDto,
    @CurrentUser() user: { _id?: string; sub?: string },
  ) {
    return this.importService.commitPendingInvoices(
      wsId,
      firmId,
      dto.rows,
      user._id ?? user.sub ?? '',
    );
  }
}
