import { Module } from '@nestjs/common';
import { TaxComputationService } from './tax-computation.service';
import { CessRulesModule } from '../../inventory/cess/cess-rules.module';

@Module({
  imports: [CessRulesModule],
  providers: [TaxComputationService],
  exports: [TaxComputationService],
})
export class TaxComputationModule {}
