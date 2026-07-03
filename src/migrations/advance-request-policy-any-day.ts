import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../modules/salary/schemas/payroll-config.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Advance-request policy default-open (2026-07-03, owner directive) — flip
 * fixed_day advance-request policies to `any_day` so employees can request an
 * advance on any day of the month by default. Windows/fixed days become a
 * per-workspace OPT-IN via Payroll Settings.
 *
 * Context: migration 0039 pinned pre-policy workspaces to
 * { mode: 'fixed_day', fixedDay: advanceRequestDay ?? 15 } to preserve legacy
 * behaviour, which made advance requests read "not open right now" on every
 * other day. The owner ruled the default should be open-anytime.
 *
 * Scope: only `mode: 'fixed_day'` docs flip (covers the 0039-stamped shape);
 * `window` policies are left untouched (an explicit range is a deliberate
 * owner choice). fixedDay is kept on the doc so switching back in settings
 * restores the old day. One-shot, idempotent (mode filter => re-run matches 0).
 * Links: advance-request-window.util.ts, backfill-advance-request-policy.ts.
 */
@Injectable()
export class AdvanceRequestPolicyAnyDayService {
  private readonly logger = new Logger(AdvanceRequestPolicyAnyDayService.name);

  constructor(
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async run(): Promise<MigrationResult> {
    const res = await this.payrollConfigModel.updateMany(
      { 'disbursementRules.advanceRequestPolicy.mode': 'fixed_day' },
      { $set: { 'disbursementRules.advanceRequestPolicy.mode': 'any_day' } },
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `advance-request-policy any-day: matched=${matched} modified=${modified} (fixed_day workspaces opened)`,
    );
    return { matched, modified };
  }
}
