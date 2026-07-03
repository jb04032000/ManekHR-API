/**
 * TallyExportModule — Phase 16 Plan 02 (FIN-15-01).
 *
 * Registers controller + service + generators + validator. Imports MongooseModule
 * for every collection consumed by the orchestrator.
 *
 * Guard providers (JwtAuthGuard, RolesGuard, SubscriptionGuard) are registered
 * at the app level — controller-level @UseGuards picks them up via DI.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

import { TallyExportController } from './tally-export.controller';
import { TallyExportService } from './tally-export.service';
import { MastersGenerator } from './generators/masters.generator';
import { VoucherGenerator } from './generators/voucher.generator';
import { PreExportValidator } from './validators/pre-export-validator.service';

import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../sales/ledger-posting/ledger-entry.schema';
import { Account, AccountSchema } from '../ledger/account.schema';
import { Party, PartySchema } from '../parties/party.schema';
import { Item, ItemSchema } from '../items/item.schema';
import { Firm, FirmSchema } from '../firms/firm.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../sales/sale-invoice/sale-invoice.schema';
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: Account.name, schema: AccountSchema },
      { name: Party.name, schema: PartySchema },
      { name: Item.name, schema: ItemSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
    ]),
    AuditModule,
  ],
  controllers: [TallyExportController],
  providers: [
    TallyExportService,
    MastersGenerator,
    VoucherGenerator,
    PreExportValidator,
  ],
  exports: [TallyExportService, PreExportValidator],
})
export class TallyExportModule {}
