import { Global, Module } from '@nestjs/common';
import { PrintI18nService } from './print-i18n.service';

/**
 * PrintI18nModule — global so any voucher print service can inject it.
 */
@Global()
@Module({
  providers: [PrintI18nService],
  exports: [PrintI18nService],
})
export class PrintI18nModule {}
