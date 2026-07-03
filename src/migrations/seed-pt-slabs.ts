import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PtSlabConfig } from '../modules/salary/schemas/pt-slab.schema';

/**
 * Seeds the default per-state Professional Tax (PT) slab configs (ADR-0001
 * loose-ends). This logic previously ran in `AdminService.onModuleInit` on EVERY
 * boot; it now runs via the migration runner. A dedicated service that injects
 * only the `PtSlabConfig` model is used deliberately — importing the heavy
 * `AdminModule` (which pulls Subscriptions/Users/Workspaces/Uploads/Audit/Connect)
 * into MigrationsModule would be disproportionate for one reference-data seed.
 *
 * Registered `convergent`: the upsert `$set`s frequency/slabs/isActive, so a
 * bumped checksum re-applies updated rates without creating duplicates (state is
 * the unique key; admin edits via the PT-slab endpoints are overwritten on
 * re-seed, matching the prior boot behaviour).
 */
@Injectable()
export class SeedPtSlabsService {
  private readonly logger = new Logger(SeedPtSlabsService.name);

  constructor(
    @InjectModel(PtSlabConfig.name)
    private readonly ptSlabConfigModel: Model<PtSlabConfig>,
  ) {}

  async runSeed(): Promise<{ states: number }> {
    const defaultPtSlabConfigs: Array<{
      state: string;
      frequency: 'monthly' | 'annual';
      slabs: Array<{ minSalary: number; maxSalary: number | null; ptAmount: number }>;
    }> = [
      {
        state: 'Gujarat',
        frequency: 'monthly',
        slabs: [
          { minSalary: 0, maxSalary: 5999, ptAmount: 0 },
          { minSalary: 6000, maxSalary: 8999, ptAmount: 80 },
          { minSalary: 9000, maxSalary: 11999, ptAmount: 150 },
          { minSalary: 12000, maxSalary: null, ptAmount: 200 },
        ],
      },
      {
        state: 'Maharashtra',
        frequency: 'monthly',
        slabs: [
          { minSalary: 0, maxSalary: 7500, ptAmount: 0 },
          { minSalary: 7501, maxSalary: 10000, ptAmount: 175 },
          // Simplified approximation: February-specific surcharge is not modeled yet.
          { minSalary: 10001, maxSalary: null, ptAmount: 200 },
        ],
      },
      {
        state: 'Karnataka',
        frequency: 'monthly',
        slabs: [
          { minSalary: 0, maxSalary: 24999, ptAmount: 0 },
          { minSalary: 25000, maxSalary: null, ptAmount: 200 },
        ],
      },
      {
        state: 'Telangana',
        frequency: 'monthly',
        slabs: [
          { minSalary: 0, maxSalary: 14999, ptAmount: 0 },
          { minSalary: 15000, maxSalary: null, ptAmount: 200 },
        ],
      },
      {
        state: 'West Bengal',
        frequency: 'monthly',
        slabs: [
          { minSalary: 0, maxSalary: 8500, ptAmount: 0 },
          { minSalary: 8501, maxSalary: 10000, ptAmount: 90 },
          { minSalary: 10001, maxSalary: 15000, ptAmount: 110 },
          { minSalary: 15001, maxSalary: 25000, ptAmount: 130 },
          { minSalary: 25001, maxSalary: 40000, ptAmount: 150 },
          { minSalary: 40001, maxSalary: null, ptAmount: 200 },
        ],
      },
      {
        state: 'Tamil Nadu',
        frequency: 'monthly',
        slabs: [{ minSalary: 0, maxSalary: null, ptAmount: 0 }],
      },
    ];

    await Promise.all(
      defaultPtSlabConfigs.map((config) =>
        this.ptSlabConfigModel
          .findOneAndUpdate(
            { state: config.state },
            {
              $set: {
                frequency: config.frequency,
                slabs: config.slabs,
                isActive: true,
              },
              $setOnInsert: {
                state: config.state,
              },
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            },
          )
          .exec(),
      ),
    );

    this.logger.log(`PT-slab seed: ${defaultPtSlabConfigs.length} state config(s) upserted.`);
    return { states: defaultPtSlabConfigs.length };
  }
}
