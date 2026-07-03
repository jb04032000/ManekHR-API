import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Proforma, ProformaSchema } from './proforma.schema';
import { ProformaService } from './proforma.service';
import { ProformaController } from './proforma.controller';
import { PartiesModule } from '../../parties/parties.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { MailModule } from '../../../mail/mail.module';
import { PrintModule } from '../print/print.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Proforma.name, schema: ProformaSchema }]),
    PartiesModule,
    VoucherSeriesModule,
    FirmsModule,
    MailModule,
    PrintModule,
  ],
  controllers: [ProformaController],
  providers: [ProformaService],
  exports: [ProformaService],
})
export class ProformaModule {}
