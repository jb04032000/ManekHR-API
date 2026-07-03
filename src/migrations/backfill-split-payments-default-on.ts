import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../modules/salary/schemas/payroll-config.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Split Payments default-on (2026-06-22, owner directive) — flip
 * features.splitPayments to true on EXISTING workspaces so the "Split Payments is
 * on by default" decision applies to already-created tenants too.
 *
 * NEW workspaces now seed splitPayments:true (basic preset + schema default), so
 * they are not affected here. EXISTING workspaces were inserted with the old basic
 * preset value (false), and a schema/preset change does NOT retroactively touch
 * stored docs — this one-shot updateMany flips every config whose
 * features.splitPayments is not already true. There is no provenance field to tell
 * "never set" apart from "deliberately disabled", and the owner's directive is
 * "default active", so all non-true values are turned on.
 *
 * Atomic + idempotent: the { $ne: true } filter means a re-run matches nothing once
 * applied. Reversible (set back to false / drop this unit). Enabling the flag only
 * UNLOCKS split payloads; it never alters existing payment records.
 * Links: payroll-config.schema.ts features.splitPayments, payroll-presets.ts,
 * salary.service.ts assertFeatureEnabled (the split-payment 400 gate).
 */
@Injectable()
export class BackfillSplitPaymentsDefaultOnService {
  private readonly logger = new Logger(BackfillSplitPaymentsDefaultOnService.name);

  constructor(
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async run(): Promise<MigrationResult> {
    const res = await this.payrollConfigModel.updateMany(
      { 'features.splitPayments': { $ne: true } },
      { $set: { 'features.splitPayments': true } },
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `split-payments default-on backfill: matched=${matched} modified=${modified} (existing workspaces enabled)`,
    );
    return { matched, modified };
  }
}
