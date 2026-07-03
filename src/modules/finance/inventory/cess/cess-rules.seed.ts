import { Injectable, Logger } from '@nestjs/common';
import { CessRulesService } from './cess-rules.service';

/**
 * CessRulesSeed — D-08 idempotent seed of GST Council cess buckets.
 *
 * Run by the ledgered migration runner (ADR-0001 Slice 2), unit
 * `0010_finance_seed_cess_rules` — was an onModuleInit hook that ran on EVERY
 * boot. Do NOT re-add a boot hook on merge. Idempotency is guaranteed by
 * CessRulesService.upsert() (findOneAndUpdate upsert:true keyed on hsnCode); it
 * UPDATES rates, so it is registered `convergent` (re-applies on a checksum bump).
 *
 * Source: GST Council rates as of FY 2025-26 (April 2025).
 * HSN buckets: tobacco (2401, 2402, 2403), pan masala (2106), aerated drinks (2202),
 * coal/lignite/peat (2701-2703), motor vehicles (8703).
 */
@Injectable()
export class CessRulesSeed {
  private readonly logger = new Logger(CessRulesSeed.name);

  constructor(private readonly cessRulesService: CessRulesService) {}

  async runSeed(): Promise<{ seeded: number; total: number }> {
    const seed = [
      {
        hsnCode: '2401',
        description: 'Tobacco (unmanufactured)',
        cessType: 'compound' as const,
        adValoremRate: 71,
        specificRatePerUnit: 0,
        specificRateUnit: 'kg' as const,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2402',
        description: 'Cigarettes (manufactured tobacco substitutes)',
        cessType: 'compound' as const,
        adValoremRate: 5,
        specificRatePerUnit: 4170, // ₹41.70 per thousand pieces = 4170 paise per piece/1000
        specificRateUnit: 'piece' as const,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2403',
        description: 'Other manufactured tobacco and substitutes',
        cessType: 'ad_valorem' as const,
        adValoremRate: 65,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2106',
        description: 'Pan masala',
        cessType: 'ad_valorem' as const,
        adValoremRate: 60,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2202',
        description: 'Aerated waters / drinks',
        cessType: 'ad_valorem' as const,
        adValoremRate: 12,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2701',
        description: 'Coal; briquettes, ovoids and similar solid fuels manufactured from coal',
        cessType: 'specific' as const,
        specificRatePerUnit: 40000, // ₹400 per tonne = 40000 paise
        specificRateUnit: 'tonne' as const,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2702',
        description: 'Lignite, whether or not agglomerated',
        cessType: 'specific' as const,
        specificRatePerUnit: 40000,
        specificRateUnit: 'tonne' as const,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '2703',
        description: 'Peat (including peat litter), whether or not agglomerated',
        cessType: 'specific' as const,
        specificRatePerUnit: 40000,
        specificRateUnit: 'tonne' as const,
        applicableFrom: '2025-04-01',
      },
      {
        hsnCode: '8703',
        description: 'Motor vehicles for transport of persons (large engine / luxury segment)',
        cessType: 'ad_valorem' as const,
        adValoremRate: 22,
        applicableFrom: '2025-04-01',
      },
    ];

    let seeded = 0;
    for (const r of seed) {
      try {
        await this.cessRulesService.upsert(r as any);
        seeded++;
      } catch (err) {
        this.logger.warn(`Failed to seed CessRule for HSN ${r.hsnCode}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`CessRule seed complete: ${seeded}/${seed.length} rules upserted`);
    return { seeded, total: seed.length };
  }
}
