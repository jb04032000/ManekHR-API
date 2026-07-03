import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReminderDispatcherService } from './reminder-dispatcher.service';
import {
  CRON_SCHEDULES,
  CronJobKey,
  CRON_TIMEZONES,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';

/**
 * IMPORTANT: ScheduleModule.forRoot() is NOT registered here — already global via SalaryModule.
 */
@Injectable()
export class ReminderDispatcherCron {
  private readonly logger = new Logger(ReminderDispatcherCron.name);

  constructor(
    private readonly dispatcher: ReminderDispatcherService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Payment/maintenance reminder dispatcher
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 07:30 IST - dispatch due payment + maintenance reminders.
   * Idempotent:  YES - the service writes a per-(party/invoice, day) idempotency
   *              log with a unique index; duplicate-key (E11000) "already sent
   *              today" is swallowed (verified in reminder-dispatcher.service).
   * Reads:       parties, invoices, reminder rules
   * Writes:      reminder idempotency log; sends SMS/WhatsApp/email reminders
   * Missed run:  Self-heals - the next day re-scans due reminders.
   * Owner:       finance/reminders
   */
  @Cron(CRON_SCHEDULES.REMINDER_DISPATCHER, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.REMINDER_DISPATCHER,
  })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.REMINDER_DISPATCHER, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    this.logger.log('ReminderDispatcherCron starting');
    try {
      const result = await this.dispatcher.runForAllWorkspaces();
      this.logger.log(`ReminderDispatcherCron complete: ${JSON.stringify(result)}`);
    } catch (err: any) {
      this.logger.error(`ReminderDispatcherCron failed: ${err?.message ?? err}`);
    }
  }
}
