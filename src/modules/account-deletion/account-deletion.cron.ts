import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../common/constants/cron.constants';
import { AccountDeletionFinalizeService } from './account-deletion-finalize.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * Account-deletion lifecycle crons (Phase 2, ACCOUNT-DELETION-AND-DPDP-PLAN.md §6).
 *
 * Both are Redis single-flight wrapped so a given daily occurrence runs on at
 * most one worker (and, with the web role gate in main.ts, only on the worker
 * process). `ScheduleModule.forRoot()` is registered once app-wide (SalaryModule),
 * so these @Cron handlers are auto-discovered — no per-module forRoot.
 *
 * KEY: the finalize sweep runs REGARDLESS of `RUN_RETENTION_PURGE_ON_SCHEDULE`
 * (there is deliberately NO env gate here). That OFF-by-default master switch
 * gates only the STATUTORY de-identified purge (plan §8); the targeted personal-
 * data Day-30 finalize is the user-facing guarantee and always runs, so "your
 * personal data is permanently removed after 30 days" is true and owner-proof.
 */
@Injectable()
export class AccountDeletionCron {
  private readonly logger = new Logger(AccountDeletionCron.name);

  constructor(
    private readonly finalizeService: AccountDeletionFinalizeService,
    private readonly accountDeletionService: AccountDeletionService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * Day-30 finalize sweep. 04:30 UTC daily — clear of the salary (03:30),
   * attendance (03:45), bills (04:00), workspace/uploads (04:15) retention crons.
   */
  @Cron('30 4 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handleFinalize(): Promise<void> {
    await this.singleFlight.runExclusive('account_deletion.finalize', dayBucket(), () =>
      this.finalizeService.finalizeDuePending(),
    );
  }

  /**
   * Scope-1 Connect-only Day-30 purge sweep. 04:35 UTC daily — staggered just
   * after the whole-account finalize (04:30) and clear of the Connect over-limit
   * (04:45) reconcile. Like the account finalize it runs REGARDLESS of
   * `RUN_RETENTION_PURGE_ON_SCHEDULE` (it is the personal-data guarantee for the
   * "delete my Connect" scope, not the statutory purge).
   */
  @Cron('35 4 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handleConnectFinalize(): Promise<void> {
    await this.singleFlight.runExclusive('account_deletion.connect_finalize', dayBucket(), () =>
      this.finalizeService.finalizeDueConnectPending(),
    );
  }

  /**
   * ~Day-25 "recovery window closing" reminder sweep. 05:15 UTC daily — clear of
   * the Connect over-limit (04:45) and ERP member-cap (05:00) reconciles.
   */
  @Cron('15 5 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handleReminder(): Promise<void> {
    await this.singleFlight.runExclusive('account_deletion.reminder', dayBucket(), () =>
      this.accountDeletionService.remindDuePending(),
    );
  }
}
