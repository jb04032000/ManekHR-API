import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportsController } from './reports.controller';
import { FinancialStatementsService } from './services/financial-statements.service';
import { DashboardKpiService } from './services/dashboard-kpi.service';
import { GstRegistersService } from './services/gst-registers.service';
import { PartyLedgerService } from './services/party-ledger.service';
import { InventoryReportsService } from './services/inventory-reports.service';
import { ManufacturingReportsService } from './services/manufacturing-reports.service';
import { FixedAssetsReportsService } from './services/fixed-assets-reports.service';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import { Account, AccountSchema } from '../ledger/account.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill, PurchaseBillSchema } from '../purchases/purchase-bill/purchase-bill.schema';
import { Party, PartySchema } from '../parties/party.schema';
// R7 dashboard tiles: broker-commission register (K-08) + job-work lots (K-10 takas warning).
import {
  BrokerCommissionEntry,
  BrokerCommissionEntrySchema,
} from '../payments/broker-commission/broker-commission.schema';
import { JobWorkLot, JobWorkLotSchema } from '../job-work/jw-lot/jw-lot.schema';
import { GstModule } from '../gst/gst.module';
import { StockSummaryModule } from '../inventory/stock-summary/stock-summary.module';
import { ReportCacheModule } from '../report-cache/report-cache.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: Account.name, schema: AccountSchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: Party.name, schema: PartySchema },
      { name: BrokerCommissionEntry.name, schema: BrokerCommissionEntrySchema },
      { name: JobWorkLot.name, schema: JobWorkLotSchema },
    ]),
    // GstModule exports Gstr1Module and Gstr3bModule which export Gstr1Service and Gstr3bService
    // — required for GstRegistersService injection of R-08 (GSTR-1) and R-09 (GSTR-3B) delegation
    GstModule,
    // StockSummaryModule exports StockSummaryService for R-33 delegation in InventoryReportsService
    StockSummaryModule,
    // D17 report result cache (ReportCacheService) for the dashboard KPIs
    ReportCacheModule,
  ],
  controllers: [ReportsController],
  providers: [
    FinancialStatementsService,
    DashboardKpiService,
    GstRegistersService,
    PartyLedgerService,
    InventoryReportsService,
    ManufacturingReportsService,
    FixedAssetsReportsService,
  ],
  exports: [
    FinancialStatementsService,
    DashboardKpiService,
    GstRegistersService,
    PartyLedgerService,
    InventoryReportsService,
    ManufacturingReportsService,
    FixedAssetsReportsService,
  ],
})
export class ReportsModule {}
