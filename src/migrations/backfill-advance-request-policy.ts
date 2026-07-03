import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../modules/salary/schemas/payroll-config.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Advance self-service (2026-06-14) — stamp existing workspaces' payroll configs
 * with an explicit advanceRequestPolicy preserving their CURRENT behaviour.
 *
 * NEW workspaces default to `any_day` (schema default, applied on insert).
 * EXISTING workspaces predate the policy field; the createRequest guard already
 * falls back to fixed_day(advanceRequestDay) for them via a .lean() read, but we
 * stamp it EXPLICITLY here so a later hydrated save can never silently flip a
 * live tenant open. Each doc gets { mode: 'fixed_day', fixedDay: its own
 * advanceRequestDay } (defaulting to day 15 when absent).
 *
 * Atomic + idempotent: only documents WITHOUT an advanceRequestPolicy are
 * touched (a single aggregation-pipeline updateMany), so a re-run is a no-op.
 * Links: payroll-config.schema.ts disbursementRules.advanceRequestPolicy,
 * advance-request-window.util.ts.
 */
@Injectable()
export class BackfillAdvanceRequestPolicyService {
  private readonly logger = new Logger(BackfillAdvanceRequestPolicyService.name);

  constructor(
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async run(): Promise<MigrationResult> {
    const res = await this.payrollConfigModel.updateMany(
      { 'disbursementRules.advanceRequestPolicy': { $exists: false } },
      [
        {
          $set: {
            'disbursementRules.advanceRequestPolicy': {
              mode: 'fixed_day',
              fixedDay: { $ifNull: ['$disbursementRules.advanceRequestDay', 15] },
            },
          },
        },
      ],
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `advance-request-policy backfill: matched=${matched} modified=${modified} (existing workspaces pinned to fixed_day)`,
    );
    return { matched, modified };
  }
}
