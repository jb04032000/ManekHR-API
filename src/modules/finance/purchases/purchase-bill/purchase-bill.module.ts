import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseBill, PurchaseBillSchema } from './purchase-bill.schema';
import { PurchaseBillService } from './purchase-bill.service';
import { PurchaseBillPolicyService } from './purchase-bill-policy.service';
import { PurchaseBillController } from './purchase-bill.controller';
// Read-only models for the maker-checker exemption resolution (OQ-FB-5). By
// name token — no WorkspacesModule/RbacModule import, so no cycle.
import { Workspace, WorkspaceSchema } from '../../../workspaces/schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../../../workspaces/schemas/workspace-member.schema';
import { Role, RoleSchema } from '../../../rbac/schemas/role.schema';
import { TeamMember, TeamMemberSchema } from '../../../team/schemas/team-member.schema';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { PartiesModule } from '../../parties/parties.module';
import { SalesModule } from '../../sales/sales.module';
import { TdsModule } from '../tds/tds.module';
import { CapitalGoodsItcModule } from '../capital-goods-itc/capital-goods-itc.module';
import { StockMovementsModule } from '../../inventory/stock-movements/stock-movements.module';
import { LotsModule } from '../../inventory/lots/lots.module';
import { Item, ItemSchema } from '../../items/item.schema';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: Item.name, schema: ItemSchema },
      // OQ-FB-5 maker-checker exemption resolution (read-only). Re-registering
      // these shared models is safe — @nestjs/mongoose reuses the existing
      // connection model.
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: Role.name, schema: RoleSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
    ]),
    forwardRef(() => SalesModule), // provides LedgerPostingService + IdempotencyService
    VoucherSeriesModule,
    FirmsModule,
    PartiesModule,
    TdsModule,
    CapitalGoodsItcModule,
    StockMovementsModule,
    LotsModule,
    FiscalYearModule,
  ],
  controllers: [PurchaseBillController],
  providers: [PurchaseBillService, PurchaseBillPolicyService],
  exports: [PurchaseBillService],
})
export class PurchaseBillModule {}
