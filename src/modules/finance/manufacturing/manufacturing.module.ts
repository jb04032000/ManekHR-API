import { Module } from '@nestjs/common';
import { BomModule } from './bom/bom.module';
import { ManufacturingVouchersModule } from './manufacturing-vouchers/manufacturing-vouchers.module';

/**
 * ManufacturingModule — aggregates BomModule + ManufacturingVouchersModule.
 * Imported by FinanceModule (F-10 Wave 5).
 */
@Module({
  imports: [BomModule, ManufacturingVouchersModule],
  exports: [BomModule, ManufacturingVouchersModule],
})
export class ManufacturingModule {}
