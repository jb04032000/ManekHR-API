import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../modules/salary/schemas/payroll-config.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Advance Payments default-on (2026-07-03, owner directive) — flip
 * features.advancePayments to true on EXISTING workspaces so employee
 * advance-salary requests work out of the box ("Salary advances are turned off
 * for this workspace" 400 on createRequest, hidden Advances CTA on MySalary).
 * NEW workspaces now seed true (basic preset + schema default). Owners can
 * still switch it off per workspace in Payroll Settings.
 *
 * Mirrors the 0049 split-payments backfill exactly: no provenance field tells
 * "never set" apart from "deliberately disabled", and the owner's directive is
 * "default active", so all non-true values flip on. Atomic + idempotent
 * ({ $ne: true } filter => re-run matches nothing). Reversible per workspace.
 * Links: payroll-config.schema.ts features.advancePayments, payroll-presets.ts,
 * advance-salary-request.service.ts createRequest (the SALARY_ADVANCE_DISABLED gate).
 */
@Injectable()
export class BackfillAdvancePaymentsDefaultOnService {
  private readonly logger = new Logger(BackfillAdvancePaymentsDefaultOnService.name);

  constructor(
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async run(): Promise<MigrationResult> {
    const res = await this.payrollConfigModel.updateMany(
      { 'features.advancePayments': { $ne: true } },
      { $set: { 'features.advancePayments': true } },
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `advance-payments default-on backfill: matched=${matched} modified=${modified} (existing workspaces enabled)`,
    );
    return { matched, modified };
  }
}
