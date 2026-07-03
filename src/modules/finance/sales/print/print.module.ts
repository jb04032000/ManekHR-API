import { Module } from '@nestjs/common';
import { PrintService } from './print.service';
import { PrintI18nModule } from '../print-i18n/print-i18n.module';

/**
 * PrintModule — production renderer (Phase 16 Plan 05).
 * Imports PrintI18nModule so PrintService can inject PrintI18nService for
 * label translation across en/gu/hi.
 */
@Module({
  imports: [PrintI18nModule],
  providers: [PrintService],
  exports: [PrintService],
})
export class PrintModule {}
