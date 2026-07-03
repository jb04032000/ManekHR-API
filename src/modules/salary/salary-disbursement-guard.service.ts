import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PayrollConfig } from './schemas/payroll-config.schema';

export interface AssertPaymentAllowedOpts {
  isAdvance?: boolean;
  isOwner?: boolean;
}

/**
 * SalaryDisbursementGuardService
 *
 * Enforces D-01 business rules:
 *   1. Month-complete gate: salary for month M can only be paid after M has ended.
 *   2. Payout-window gate: payment day must fall within [salaryDate, salaryDate + payoutWindowDays].
 *
 * Owner-bypassable (D-01 "Only the workspace owner can override the gate"):
 *   - If opts.isOwner === true, the gate is skipped after a security-log entry.
 *
 * Advance-exempt:
 *   - If opts.isAdvance === true, the gate is skipped entirely (advances are
 *     same-month by definition, D-02).
 */
@Injectable()
export class SalaryDisbursementGuardService {
  private readonly logger = new Logger(SalaryDisbursementGuardService.name);

  constructor(
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
  ) {}

  async assertPaymentAllowed(
    workspaceId: string,
    salaryMonth: number,
    salaryYear: number,
    opts: AssertPaymentAllowedOpts = {},
  ): Promise<void> {
    // GATE DISABLED per owner decision 2026-06-22. This whole month-complete +
    // payout-window check is a no-op: it blocked the common factory pattern of paying
    // salary in the SAME month (25th to month-end) and got in the way of the owner /
    // manager recording a payment whenever they actually disburse. salaryDate and
    // payoutWindowDays (this gate's only readers) are now inert, and the "Salary payout"
    // settings group is hidden in DisbursementRulesPanel.tsx. Flip GATE_ENABLED to true
    // to re-introduce time-gating. Typed boolean so the original logic below is not
    // flagged as unreachable.
    const GATE_ENABLED: boolean = false;
    if (!GATE_ENABLED) {
      return;
    }

    // D-02: advances are not subject to the month-complete / window gate
    if (opts.isAdvance === true) {
      return;
    }

    // Owner bypass (D-01): logged per security register (T-26-07)
    if (opts.isOwner === true) {
      this.logger.warn(
        `[disbursement-guard] owner bypass of disbursement gate, ws=${workspaceId}, month=${salaryMonth}/${salaryYear}`,
      );
      return;
    }

    const config = await this.payrollConfigModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();

    const salaryDate = config?.disbursementRules?.salaryDate ?? 1;
    const payoutWindowDays = config?.disbursementRules?.payoutWindowDays ?? 5;

    // --------------------------------------------------------------------------
    // D-01 — Month-complete gate
    // monthEnd = last instant of month M in UTC.
    // Date.UTC(salaryYear, salaryMonth, 0) resolves to the last day of month M
    // because month arg is 1-based and Date.UTC month arg is 0-based, so
    // Date.UTC(year, month, 0) == last day of month M. (RESEARCH Pitfall 1)
    // --------------------------------------------------------------------------
    const monthEnd = new Date(Date.UTC(salaryYear, salaryMonth, 0, 23, 59, 59));
    if (new Date() <= monthEnd) {
      throw new BadRequestException({
        code: 'SALARY_MONTH_INCOMPLETE',
        message: `Salary for ${salaryMonth}/${salaryYear} can only be paid after the month completes.`,
      });
    }

    // --------------------------------------------------------------------------
    // D-01 — Payout-window gate (IST day-of-month)
    // --------------------------------------------------------------------------
    const todayDay = Number(
      new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
      }).format(new Date()),
    );

    if (todayDay < salaryDate || todayDay > salaryDate + payoutWindowDays) {
      throw new BadRequestException({
        code: 'SALARY_WINDOW_CLOSED',
        message: `Salary payment is only allowed between day ${salaryDate} and ${salaryDate + payoutWindowDays}.`,
      });
    }
  }
}
