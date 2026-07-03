import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { Firm } from '../../firms/firm.schema';
import { VerifyDataService } from './verify-data.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/**
 * VerifyDataCronService — nightly 02:00 IST Verify-My-Data scanner.
 *
 * Iterates all active firms × current + previous period and runs the full
 * 11-check scan for each combination. Per-firm try/catch ensures one bad
 * firm doesn't block others (T-12-W4-01 DoS mitigation).
 *
 * Schedule: @Cron('0 2 * * *', { timeZone: 'Asia/Kolkata' })
 *   → 02:00 IST = 20:30 UTC (non-DST), well outside peak business hours.
 *
 * NOTE: ScheduleModule.forRoot() is NOT imported here — it is already
 * registered globally in SalaryModule. NestJS cron decorators work as long
 * as ScheduleModule.forRoot() is present anywhere in the application.
 */
@Injectable()
export class VerifyDataCronService {
  private readonly logger = new Logger(VerifyDataCronService.name);

  constructor(
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    private readonly verifyDataService: VerifyDataService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * handleNightlyVerify — triggered nightly at 02:00 IST.
   *
   * Scans all active firms for current period + previous period.
   * Previous period is included because firms often file with a day or two delay.
   *
   * To manually trigger in development / smoke test:
   *   await verifyDataCronService.handleNightlyVerify();
   */
  /**
   * CRON CONTRACT - Nightly GST Verify-My-Data scan
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 02:00 IST - scan active firms for current + previous period.
   * Idempotent:  YES - VerifyDataService.runScan overwrites the per-(firm, period)
   *              scan result; a re-run recomputes the same result (no accumulation).
   * Reads:       firms, GST data
   * Writes:      verify-data scan results (overwrite per firm/period)
   * Missed run:  Self-heals - the next night re-scans both periods.
   * Owner:       finance/gst
   */
  @Cron('0 2 * * *', { timeZone: 'Asia/Kolkata' })
  async handleNightlyVerify(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_GST_VERIFY_DATA, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    const currentPeriod = this.formatPeriod(now);

    // Previous month — for firms that file after month-end
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevPeriod = this.formatPeriod(prevMonthDate);

    this.logger.log(
      `Starting nightly Verify-My-Data scan for periods: ${prevPeriod}, ${currentPeriod}`,
    );

    // Query active firms that have GST compliance enabled
    // (firms without isDeleted=true; subscription filter handled by cron context)
    const firms = await this.firmModel
      .find({ isDeleted: { $ne: true } })
      .select('_id workspaceId')
      .lean();

    let successCount = 0;
    let errorCount = 0;

    for (const firm of firms) {
      for (const period of [prevPeriod, currentPeriod]) {
        try {
          await this.verifyDataService.runScan(
            firm.workspaceId.toString(),
            (firm._id as any).toString(),
            period,
            'cron',
          );
          successCount++;
        } catch (err: any) {
          errorCount++;
          this.logger.error(
            `Verify scan failed for firm ${String(firm._id)} period ${period}: ${err?.message ?? 'unknown error'}`,
          );
          // Continue — don't let one firm's failure break the entire loop
        }
      }
    }

    this.logger.log(
      `Nightly Verify-My-Data scan complete: ${successCount} succeeded, ${errorCount} failed`,
    );
  }

  /**
   * Format a Date to MMYYYY period string.
   * e.g. new Date(2025, 3, 1) → '042025' (April 2025)
   */
  private formatPeriod(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${mm}${yyyy}`;
  }
}
