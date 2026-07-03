import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { CompOffService } from './comp-off.service';
import { LeaveYearEndService } from './leave-year-end.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';

/** Days into January during which the year-end close is still attempted. */
const YEAR_END_GRACE_DAYS = 7;

/** Stable distinct-id for system-triggered (cron) PostHog events — leave has
 *  no acting user. Mirrors the `creditSource: 'system'` convention. */
const LEAVE_CRON_DISTINCT_ID = 'system:leave-cron';

/**
 * Leave-maintenance crons (L2b) — comp-off lot expiry + the annual year-end
 * close. Both handlers are idempotent. `ScheduleModule.forRoot()` is global
 * (SalaryModule) — not imported here.
 */
@Injectable()
export class LeaveMaintenanceCron {
  private readonly logger = new Logger(LeaveMaintenanceCron.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    private readonly compOffService: CompOffService,
    private readonly yearEndService: LeaveYearEndService,
    private readonly postHog: PostHogService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Comp-off lot expiry (L2b)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 03:00 IST - expire comp-off lots past their validity.
   * Idempotent:  YES - expiry queries only lots with lotRemaining > 0 and zeroes
   *              them; a re-run sees lotRemaining = 0 and skips (state-idempotent).
   * Reads:       comp-off lots
   * Writes:      comp_off_expiry ledger entries; zeroes lotRemaining
   * Missed run:  Self-heals - the next day expires any lots now past validity.
   * Owner:       leave
   */
  @Cron(CRON_SCHEDULES.LEAVE_COMP_OFF_EXPIRY, {
    name: CronJobKey.LEAVE_COMP_OFF_EXPIRY,
    timeZone: CRON_TIMEZONES.IST,
  })
  async runCompOffExpiry(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.LEAVE_COMP_OFF_EXPIRY, dayBucket(), () =>
      this.processCompOffExpiry(),
    );
  }

  private async processCompOffExpiry(): Promise<void> {
    await this.tracer.startActiveSpan('leave.compOffExpiryCron', async (span) => {
      const startedAt = Date.now();
      try {
        const result = await this.compOffService.expireCompOffLots(new Date());
        const durationMs = Date.now() - startedAt;
        if (result.lotsExpired > 0 || result.errors.length > 0) {
          this.logger.log(
            `[LeaveMaintenanceCron] comp-off expiry — lots=${result.lotsExpired} days=${result.daysExpired} errors=${result.errors.length}`,
          );
        }
        span.setAttributes({
          lotsExpired: result.lotsExpired,
          daysExpired: result.daysExpired,
          errors: result.errors.length,
          durationMs,
        });
        this.postHog.capture({
          distinctId: LEAVE_CRON_DISTINCT_ID,
          event: 'leave.comp_off_expiry_cron_completed',
          properties: {
            lotsExpired: result.lotsExpired,
            daysExpired: result.daysExpired,
            errors: result.errors.length,
            durationMs,
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        this.logger.error(
          `[LeaveMaintenanceCron] comp-off expiry aborted: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        Sentry.captureException(err, {
          tags: { module: 'leave', op: 'comp_off_expiry_cron' },
        });
      } finally {
        span.end();
      }
    });
  }

  /**
   * Daily 02:00 IST — run the year-end close for the prior calendar year
   * during the first week of January. Idempotent, so re-running across the
   * grace window is safe; a no-op for the rest of the year.
   */
  /**
   * CRON CONTRACT - Leave year-end close (L2b)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 02:00 IST - runs only in the first week of January.
   * Idempotent:  YES - LeaveYearEndService skips a bucket already carrying a
   *              carry_forward/lapse/encashment entry for the closing year
   *              (alreadyClosed countDocuments guard, verified in service).
   * Reads:       leave balances/ledger, members
   * Writes:      carry_forward / lapse / encashment ledger entries
   * Missed run:  Self-heals across the Jan grace window; a no-op the rest of year.
   * Owner:       leave
   */
  @Cron(CRON_SCHEDULES.LEAVE_YEAR_END, {
    name: CronJobKey.LEAVE_YEAR_END,
    timeZone: CRON_TIMEZONES.IST,
  })
  async runYearEnd(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.LEAVE_YEAR_END, dayBucket(), () =>
      this.processYearEnd(),
    );
  }

  private async processYearEnd(): Promise<void> {
    const now = new Date();
    if (now.getUTCMonth() !== 0 || now.getUTCDate() > YEAR_END_GRACE_DAYS) {
      return; // only the first week of January
    }
    const fromYear = now.getUTCFullYear() - 1;
    await this.tracer.startActiveSpan('leave.yearEndCron', async (span) => {
      const startedAt = Date.now();
      span.setAttribute('fromYear', fromYear);
      try {
        const result = await this.yearEndService.runYearEndAllWorkspaces(fromYear);
        const durationMs = Date.now() - startedAt;
        this.logger.log(
          `[LeaveMaintenanceCron] year-end ${fromYear} — workspaces=${result.workspacesScanned} balances=${result.balancesProcessed} carriedForward=${result.carriedForward} lapsed=${result.lapsed} encashments=${result.encashmentRecords} errors=${result.errors.length}`,
        );
        span.setAttributes({
          workspacesScanned: result.workspacesScanned,
          balancesProcessed: result.balancesProcessed,
          carriedForward: result.carriedForward,
          lapsed: result.lapsed,
          encashmentRecords: result.encashmentRecords,
          errors: result.errors.length,
          durationMs,
        });
        this.postHog.capture({
          distinctId: LEAVE_CRON_DISTINCT_ID,
          event: 'leave.year_end_cron_completed',
          properties: {
            fromYear,
            workspacesScanned: result.workspacesScanned,
            balancesProcessed: result.balancesProcessed,
            carriedForward: result.carriedForward,
            lapsed: result.lapsed,
            encashmentRecords: result.encashmentRecords,
            errors: result.errors.length,
            durationMs,
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        this.logger.error(
          `[LeaveMaintenanceCron] year-end ${fromYear} aborted: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        Sentry.captureException(err, {
          tags: { module: 'leave', op: 'year_end_cron' },
        });
      } finally {
        span.end();
      }
    });
  }
}
