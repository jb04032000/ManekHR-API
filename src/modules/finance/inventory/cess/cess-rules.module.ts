import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CessRule, CessRuleSchema } from './cess-rule.schema';
import { CessRulesService } from './cess-rules.service';
import { CessRulesController } from './cess-rules.controller';
import { CessRulesSeed } from './cess-rules.seed';

/**
 * CessRulesModule — D-08 GST Cess registry.
 *
 * Provides CessRulesService for injection by TaxComputationModule (Task 3b).
 * Seeds 9 HSN cess buckets idempotently on module init via CessRulesSeed.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: CessRule.name, schema: CessRuleSchema }])],
  providers: [CessRulesService, CessRulesSeed],
  controllers: [CessRulesController],
  // CessRulesSeed exported so the ledgered migration runner (ADR-0001 Slice 2)
  // can run it via `npm run migrate` instead of an onModuleInit boot hook.
  exports: [CessRulesService, CessRulesSeed],
})
export class CessRulesModule {}
