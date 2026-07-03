import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../modules/salary/schemas/payroll-config.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Loan defaults-on (2026-06-22, owner directive) — make the 0% EMPLOYEE loan
 * available by default on EXISTING workspaces by turning on BOTH in-product gates it
 * needs: features.loanManagement (the employer-loan module) and
 * loanConfig.selfApplyEnabled (the worker self-apply AND-gate).
 *
 * NEW workspaces now seed both true (basic preset features.loanManagement + the
 * features/loanConfig schema defaults). EXISTING workspaces were inserted with the
 * old defaults (both off), and a schema/preset change does not touch stored docs —
 * this one-shot updateMany flips any config still missing either flag. An owner can
 * still switch either off per workspace afterward.
 *
 * Atomic + idempotent: the $or filter matches only docs needing at least one flip, so
 * a re-run modifies 0. Reversible (set back to false / drop this unit). NOTE: loan
 * endpoints are ALSO subject to the workspace's subscription (the 'loan_management'
 * sub-feature); this only flips the in-product feature gates, not the plan.
 * Links: payroll-config.schema.ts (features.loanManagement + loanConfig.selfApplyEnabled),
 * payroll-presets.ts, loan-request.service.ts createRequest gates.
 */
@Injectable()
export class BackfillLoanDefaultsOnService {
  private readonly logger = new Logger(BackfillLoanDefaultsOnService.name);

  constructor(
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async run(): Promise<MigrationResult> {
    const res = await this.payrollConfigModel.updateMany(
      {
        $or: [
          { 'features.loanManagement': { $ne: true } },
          { 'loanConfig.selfApplyEnabled': { $ne: true } },
        ],
      },
      {
        $set: {
          'features.loanManagement': true,
          'loanConfig.selfApplyEnabled': true,
        },
      },
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `loan defaults-on backfill: matched=${matched} modified=${modified} (existing workspaces: loanManagement + selfApplyEnabled enabled)`,
    );
    return { matched, modified };
  }
}
