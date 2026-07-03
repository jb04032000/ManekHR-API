import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CapitalGoodsItcSchedule } from './capital-goods-itc-schedule.schema';

/** Format a Date as YYYY-MM string (no external dependency) */
function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Parse a YYYY-MM string to the 1st of that month as a Date */
function parseYearMonth(ym: string): Date {
  const [year, month] = ym.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

/** Return a new Date with N months added */
function addMonthsToDate(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/**
 * Monthly cron that releases 1/60 of capital-goods ITC deferred in 1103.
 *
 * Runs at 02:00 IST on the 1st of every month.
 * For each amortising schedule due this month:
 *   - Computes releasePaise: exact remainder on last instalment to prevent drift.
 *   - Posts Dr 1101/1102 or 1100 Cr 1103 via LedgerPostingService.
 *   - Increments monthsAmortised; advances nextAmortisationMonth.
 *   - Sets status='completed' after 60th release.
 */
@Injectable()
export class CapitalGoodsItcCron {
  private readonly logger = new Logger(CapitalGoodsItcCron.name);

  constructor(
    @InjectModel(CapitalGoodsItcSchedule.name)
    private readonly model: Model<CapitalGoodsItcSchedule>,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Capital-goods ITC amortisation
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    1st of each month 02:00 IST - release 1/60 of deferred ITC.
   * Idempotent:  PARTIAL - cursor-guarded: each schedule advances
   *              nextAmortisationMonth after a successful release, so a normal
   *              re-run does not double-release. Residual gap: a crash between the
   *              ledger post and the cursor advance could double-release on the
   *              next run (no per-(schedule, month) claim marker). Flagged in the
   *              plan's deferred section. Single-flight removes the multi-instance case.
   * Reads:       capital_goods_itc_schedules
   * Writes:      ledger ITC-release entries; schedule cursor (monthsAmortised,
   *              nextAmortisationMonth, released paise)
   * Missed run:  Self-heals - schedules with nextAmortisationMonth <= now stay due.
   * Owner:       finance/purchases
   */
  @Cron('0 2 1 * *', { timeZone: 'Asia/Kolkata' })
  async amortiseCapitalGoodsItc(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_CAPITAL_GOODS_ITC, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const thisMonth = formatYearMonth(new Date());
    this.logger.log(`Capital-goods ITC cron started for ${thisMonth}`);

    const schedules = await this.model.find({
      status: 'amortising',
      nextAmortisationMonth: { $lte: thisMonth },
    });

    this.logger.log(`Found ${schedules.length} schedule(s) to amortise for ${thisMonth}`);

    for (const schedule of schedules) {
      try {
        const isLastInstalment = schedule.monthsAmortised + 1 >= schedule.monthsTotal;

        // Exact remainder on last instalment: prevents rounding drift over 60 months
        const releasePaise = isLastInstalment
          ? schedule.totalItcPaise - schedule.monthsAmortised * schedule.monthlyAmountPaise
          : schedule.monthlyAmountPaise;

        if (releasePaise <= 0) {
          this.logger.warn(
            `Schedule ${String(schedule._id)} releasePaise=${releasePaise} — skipping`,
          );
          continue;
        }

        // Post double-entry: Dr ITC accounts Cr 1103 Capital Goods ITC Deferred
        await this.ledgerPostingService.postCapitalGoodsItcRelease(schedule, releasePaise, {
          userId: 'cron',
        });

        // Track per-tax release amounts for reporting
        let cgstRelease = 0;
        let sgstRelease = 0;
        let igstRelease = 0;

        if (schedule.itcSplit === 'cgst_sgst' && schedule.totalItcPaise > 0) {
          cgstRelease = Math.round(
            releasePaise * (schedule.cgstTotalPaise / schedule.totalItcPaise),
          );
          sgstRelease = releasePaise - cgstRelease;
        } else {
          igstRelease = releasePaise;
        }

        schedule.monthsAmortised += 1;
        schedule.cgstReleasedPaise += cgstRelease;
        schedule.sgstReleasedPaise += sgstRelease;
        schedule.igstReleasedPaise += igstRelease;
        schedule.nextAmortisationMonth = formatYearMonth(
          addMonthsToDate(parseYearMonth(schedule.nextAmortisationMonth), 1),
        );

        if (isLastInstalment) {
          schedule.status = 'completed';
          this.logger.log(`Schedule ${String(schedule._id)} completed after 60 instalments`);
        }

        await schedule.save();
      } catch (err) {
        this.logger.error(`Failed to amortise schedule ${String(schedule._id)}: ${err}`);
      }
    }

    this.logger.log(`Capital-goods ITC cron finished for ${thisMonth}`);
  }
}
