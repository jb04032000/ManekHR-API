import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoanAccountsService } from './loan-accounts.service';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CronJobKey } from '../../../common/constants/cron.constants';

/**
 * LoanEmiCron — monthly EMI processing cron.
 *
 * Fires at 04:00 IST on the 1st of every month.
 * Different hour from DepreciationCron (03:00) and CapitalGoodsItcCron (02:00)
 * to avoid resource contention.
 *
 * IMPORTANT: ScheduleModule.forRoot() is NOT registered here or in LoanAccountsModule.
 * It is already registered globally in SalaryModule.
 *
 * Flow:
 *   1. Determine runMonth = current YYYY-MM
 *   2. Call LoanAccountsService.processEmiForMonth(runMonth)
 *   3. processEmiForMonth finds all active term loans with nextEmiMonth <= runMonth
 *   4. For each loan: upsert LoanEmiRun guard → post LedgerEntry → advance cursor
 *
 * Idempotency: LoanEmiRun unique index (firmId, loanAccountId, runMonth) prevents
 * duplicate EMI postings even if cron fires twice in the same month.
 */
@Injectable()
export class LoanEmiCron {
  private readonly logger = new Logger(LoanEmiCron.name);

  constructor(
    private readonly loanAccountsService: LoanAccountsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Loan EMI posting
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    2nd of each month 04:00 IST - post the month's EMI ledger entries.
   * Idempotent:  YES - LoanEmiRun unique {firmId, loanAccountId, runMonth} guard
   *              (findOneAndUpdate upsert); an already-completed/running month is
   *              skipped (verified in loan-accounts.service).
   * Reads:       loan accounts
   * Writes:      ledger EMI entries + LoanEmiRun guard rows
   * Missed run:  Self-heals - loans with nextEmiMonth <= runMonth are picked up
   *              on the next run.
   * Owner:       finance/loan-accounts
   */
  @Cron('0 4 2 * *', { timeZone: 'Asia/Kolkata' })
  async runMonthlyEmi(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_LOAN_EMI, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    const runMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    this.logger.log(`Loan EMI cron started for ${runMonth}`);

    try {
      await this.loanAccountsService.processEmiForMonth(runMonth, '1002');
      this.logger.log(`Loan EMI cron completed for ${runMonth}`);
    } catch (err) {
      this.logger.error(`Loan EMI cron failed for ${runMonth}: ${err}`);
    }
  }
}
