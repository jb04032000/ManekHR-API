import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { LeaveAccrualService } from './leave-accrual.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';

/** Stable distinct-id for system-triggered (cron) PostHog events — leave has
 *  no acting user. Mirrors the `creditSource: 'system'` convention. */
const LEAVE_CRON_DISTINCT_ID = 'system:leave-cron';

/**
 * Daily leave-accrual sweep (01:00 IST). Posts any missing `upfront_annual` /
 * `periodic_accrual` ledger entries for every active member.
 *
 * Idempotent — `LeaveAccrualService` skips years/periods already credited, so
 * a re-run is a no-op. A failure for one member/workspace is logged and the
 * sweep continues. `ScheduleModule.forRoot()` is registered globally
 * (SalaryModule) — not imported here.
 */
@Injectable()
export class LeaveAccrualCron {
  private readonly logger = new Logger(LeaveAccrualCron.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    private readonly accrualService: LeaveAccrualService,
    private readonly postHog: PostHogService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Leave accrual sweep (L2a)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 01:00 IST - post missing upfront/periodic leave credits.
   * Idempotent:  YES - LeaveAccrualService skips already-credited periods: upfront
   *              checks countDocuments({bucket, accrual}) > 0; periodic skips
   *              periods already in the ledger (verified in leave-accrual.service).
   * Reads:       leave types/rules, leave ledger, members
   * Writes:      leave ledger accrual entries
   * Missed run:  Self-heals - the next day re-posts any still-missing periods.
   * Owner:       leave
   */
  @Cron(CRON_SCHEDULES.LEAVE_ACCRUAL, {
    name: CronJobKey.LEAVE_ACCRUAL,
    timeZone: CRON_TIMEZONES.IST,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.LEAVE_ACCRUAL, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    await this.tracer.startActiveSpan('leave.accrualCron', async (span) => {
      const startedAt = Date.now();
      try {
        const result = await this.accrualService.accrueAllWorkspaces(new Date());
        const durationMs = Date.now() - startedAt;
        if (result.entriesPosted > 0 || result.errors.length > 0) {
          this.logger.log(
            `[LeaveAccrualCron] complete — workspaces=${result.workspacesScanned} members=${result.membersScanned} posted=${result.entriesPosted} errors=${result.errors.length} durationMs=${durationMs}`,
          );
        }
        if (result.errors.length > 0) {
          this.logger.warn(
            `[LeaveAccrualCron] ${result.errors.length} error(s): ${result.errors
              .slice(0, 10)
              .join('; ')}`,
          );
        }
        span.setAttributes({
          workspacesScanned: result.workspacesScanned,
          membersScanned: result.membersScanned,
          entriesPosted: result.entriesPosted,
          errors: result.errors.length,
          durationMs,
        });
        this.postHog.capture({
          distinctId: LEAVE_CRON_DISTINCT_ID,
          event: 'leave.accrual_cron_completed',
          properties: {
            workspacesScanned: result.workspacesScanned,
            membersScanned: result.membersScanned,
            entriesPosted: result.entriesPosted,
            errors: result.errors.length,
            durationMs,
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        this.logger.error(
          `[LeaveAccrualCron] run aborted: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        Sentry.captureException(err, {
          tags: { module: 'leave', op: 'accrual_cron' },
        });
      } finally {
        span.end();
      }
    });
  }
}
