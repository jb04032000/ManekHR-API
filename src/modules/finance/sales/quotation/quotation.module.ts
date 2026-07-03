import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Quotation, QuotationSchema } from './quotation.schema';
import { QuotationService } from './quotation.service';
import { QuotationController } from './quotation.controller';
import { PartiesModule } from '../../parties/parties.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { MailModule } from '../../../mail/mail.module';
import { PrintModule } from '../print/print.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Quotation.name, schema: QuotationSchema }]),
    PartiesModule,
    VoucherSeriesModule,
    FirmsModule,
    MailModule,
    PrintModule,
  ],
  controllers: [QuotationController],
  providers: [QuotationService],
  exports: [QuotationService],
})
export class QuotationModule {}
