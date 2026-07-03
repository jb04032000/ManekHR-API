import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { SaleInvoice, SaleInvoiceSchema } from '../sale-invoice/sale-invoice.schema';
import {
  DeliveryChallan,
  DeliveryChallanSchema,
} from '../delivery-challan/delivery-challan.schema';
import { EwaybillService } from './ewaybill.service';
import { EwaybillController } from './ewaybill.controller';
import { EwaybillPayloadBuilder } from './ewaybill-payload.builder';
import { EwbValidityService } from './ewaybill-validity.service';
import { SaleInvoiceModule } from '../sale-invoice/sale-invoice.module';
import { FirmsModule } from '../../firms/firms.module';
import { EInvoiceModule } from '../einvoice/einvoice.module';

@Module({
  imports: [
    ConfigModule,
    // Register SaleInvoice + DeliveryChallan models for direct queries (listExpiring +
    // generateForChallan). DeliveryChallan e-Way bills persist on the challan doc.
    MongooseModule.forFeature([
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: DeliveryChallan.name, schema: DeliveryChallanSchema },
    ]),
    // forwardRef: SaleInvoiceModule imports EwaybillModule and EwaybillModule imports SaleInvoiceModule
    forwardRef(() => SaleInvoiceModule),
    FirmsModule,
    // Import EInvoiceModule to access SurepassIrpProvider + NicDirectProvider (already exported)
    forwardRef(() => EInvoiceModule),
  ],
  controllers: [EwaybillController],
  providers: [EwaybillService, EwaybillPayloadBuilder, EwbValidityService],
  exports: [EwaybillService, EwaybillPayloadBuilder, EwbValidityService],
})
export class EwaybillModule {}
