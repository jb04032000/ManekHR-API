import { Module } from '@nestjs/common';
import { ConvertVoucherService } from './convert-voucher.service';
import { ConvertVoucherController } from './convert-voucher.controller';
import { QuotationModule } from '../quotation/quotation.module';
import { SaleOrderModule } from '../sale-order/sale-order.module';
import { ProformaModule } from '../proforma/proforma.module';
import { DeliveryChallanModule } from '../delivery-challan/delivery-challan.module';
import { SaleInvoiceModule } from '../sale-invoice/sale-invoice.module';

@Module({
  imports: [
    QuotationModule,
    SaleOrderModule,
    ProformaModule,
    DeliveryChallanModule,
    SaleInvoiceModule,
  ],
  controllers: [ConvertVoucherController],
  providers: [ConvertVoucherService],
  exports: [ConvertVoucherService],
})
export class ConvertModule {}
