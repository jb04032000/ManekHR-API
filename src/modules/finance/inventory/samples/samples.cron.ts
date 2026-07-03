import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { SampleVoucher, SampleVoucherDocument } from './sample-voucher.schema';

/**
 * SamplesCron — D-07 auto-alarm cron
 *
 * Schedule: CRON_SCHEDULES.SAMPLE_ALARM = '30 3 * * *' (03:30 UTC = 09:00 IST)
 *
 * Responsibilities:
 *   1. Scan sample vouchers in 'sent' or 'partially_accepted' status with
 *      expectedReturnDate within the next 30 days (upper bound cap to limit scan).
 *   2. For items already past expectedReturnDate → flip status to 'overdue'.
 *   3. For items within autoAlarmDays of expectedReturnDate → trigger alarm
 *      (notification call is a TODO deferred to F-09-08 when NotificationsModule is wired).
 *
 * NotificationsService injection deferred to F-09-08: adding it here would require
 * importing NotificationsModule into SamplesModule, which adds a cross-module dep
 * that is cleaner to wire at the integration layer rather than the entity layer.
 */
@Injectable()
export class SamplesCron {
  private readonly logger = new Logger(SamplesCron.name);

  constructor(
    @InjectModel(SampleVoucher.name)
    private readonly model: Model<SampleVoucherDocument>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Sample voucher expiry alarm (D-07)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 03:30 UTC (09:00 IST) - flag overdue / due-soon vouchers.
   * Idempotent:  YES (state) - overdue flip is a predicate updateOne guarded by
   *              status !== 'overdue'; a re-run skips already-overdue rows.
   * Reads:       sample_vouchers
   * Writes:      sample voucher status -> overdue (notification dispatch is a
   *              documented TODO, not yet wired)
   * Missed run:  Self-heals - the next day re-flags any newly-overdue vouchers.
   * Owner:       finance/inventory
   */
  @Cron(CRON_SCHEDULES.SAMPLE_ALARM, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.SAMPLE_ALARM,
  })
  async runSampleAlarm(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.SAMPLE_ALARM, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();

    // Upper bound: only fetch vouchers due within 30 days to keep the scan efficient.
    // The compound index { workspaceId, firmId, status, expectedReturnDate } covers this.
    const upperBound = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const candidates = await this.model
      .find({
        isDeleted: false,
        status: { $in: ['sent', 'partially_accepted'] },
        expectedReturnDate: { $lte: upperBound },
      })
      .lean();

    let alarmCount = 0;
    let overdueCount = 0;

    for (const v of candidates) {
      const daysUntilDue = Math.ceil(
        (v.expectedReturnDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );
      const isOverdue = daysUntilDue < 0;
      const isInAlarmWindow = daysUntilDue >= 0 && daysUntilDue <= v.autoAlarmDays;

      if (isOverdue && v.status !== 'overdue') {
        await this.model.updateOne({ _id: v._id }, { $set: { status: 'overdue' } });
        overdueCount++;

        // TODO F-09-08: notify party + firm admin
        // await this.notificationsService.sendBulk({
        //   channel: ['in_app', 'email'],
        //   template: 'sample_overdue',
        //   payload: {
        //     voucherNo: v.voucherNo,
        //     partyId: v.partyId,
        //     daysOverdue: -daysUntilDue,
        //   },
        // });
      } else if (isInAlarmWindow) {
        alarmCount++;

        // TODO F-09-08: fire due-soon notification
        // await this.notificationsService.sendBulk({
        //   channel: ['in_app', 'email'],
        //   template: 'sample_due_soon',
        //   payload: {
        //     voucherNo: v.voucherNo,
        //     partyId: v.partyId,
        //     daysRemaining: daysUntilDue,
        //   },
        // });
      }
    }

    this.logger.log(
      `Sample alarm cron: ${candidates.length} candidates scanned, ` +
        `${alarmCount} due-soon alarms, ${overdueCount} marked overdue`,
    );
  }
}
