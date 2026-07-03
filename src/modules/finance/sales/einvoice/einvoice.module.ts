import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { SaleInvoice, SaleInvoiceSchema } from '../sale-invoice/sale-invoice.schema';
import { CreditNote, CreditNoteSchema } from '../../credit-notes/credit-note.schema';
import { EInvoiceService } from './einvoice.service';
import { EInvoiceController } from './einvoice.controller';
import { EInvoiceRetryProcessor } from './einvoice-retry.processor';
import { EinvoicePayloadBuilder } from './einvoice-payload.builder';
import { SaleInvoiceModule } from '../sale-invoice/sale-invoice.module';
import { FirmsModule } from '../../firms/firms.module';
import { SurepassIrpProvider } from './providers/surepass-irp.provider';
import { NicDirectProvider } from './providers/nic-direct.provider';

@Module({
  imports: [
    ConfigModule,
    // Register the SaleInvoice model so EInvoiceService can inject it directly
    // for listPending (and future direct DB queries without going through service)
    MongooseModule.forFeature([
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      // CreditNote model so EInvoiceService can generate/persist IRN for credit notes (CRN).
      { name: CreditNote.name, schema: CreditNoteSchema },
    ]),
    // Register the 'einvoice-retry' queue against the global BullModule connection
    // (BullModule.forRootAsync is in app.module.ts — no need to re-configure connection here)
    BullModule.registerQueue({ name: 'einvoice-retry' }),
    // forwardRef: SaleInvoiceModule imports EInvoiceModule (for controller injection)
    // and EInvoiceModule imports SaleInvoiceModule — circular.
    forwardRef(() => SaleInvoiceModule),
    FirmsModule,
  ],
  controllers: [EInvoiceController],
  providers: [
    EInvoiceService,
    EInvoiceRetryProcessor,
    EinvoicePayloadBuilder,
    SurepassIrpProvider,
    NicDirectProvider,
  ],
  exports: [EInvoiceService, EinvoicePayloadBuilder, SurepassIrpProvider, NicDirectProvider],
})
export class EInvoiceModule {}
