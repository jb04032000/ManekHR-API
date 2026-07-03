import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { DefaulterAlertDispatch } from '../schemas/defaulter-alert-dispatch.schema';
import { Subscription } from '../../subscriptions/schemas/subscription.schema';
import { AttendanceService } from '../attendance.service';
import { DefaulterAlertService, type DefaulterRow } from '../defaulter-alert.service';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { resolveSubFeatureAccess } from '../../../common/utils/entitlement-resolve.util';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Lean workspace document shape required by this cron. */
interface WorkspaceLean {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  attendanceSettings?: {
    complianceThresholdPct: number;
    defaulterAlerts: {
      enabled: boolean;
      channels: { inApp: boolean; email: boolean };
      recipients: {
        mode: 'managers' | 'specificPeople' | 'both';
        specificPeople: Types.ObjectId[];
      };
    };
  };
}

/** Lean subscription shape used for entitlement check. */
interface SubscriptionLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: string;
  currentPeriodEnd?: Date;
  appliedEntitlements?: {
    moduleAccess?: Array<{
      module: string;
      enabled: boolean;
      subFeatures?: Array<{ key: string; access: string }>;
    }>;
    modules?: string[];
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ATTENDANCE_MODULE = 'attendance';
const DEFAULTER_ALERTS_SUBFEATURE = 'defaulter_alerts';

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Monthly cron — runs at 06:00 IST on the 1st of every month.
 *
 * For each workspace with `attendanceSettings.defaulterAlerts.enabled=true`:
 *  1. Skip if a `DefaulterAlertDispatch` row already exists for the prior month
 *     (idempotency guard — safe to re-run).
 *  2. Skip if the workspace owner's subscription does not entitle
 *     `attendance → defaulter_alerts` (treats LOCKED / missing as no-access,
 *     mirrors SubscriptionGuard resolution logic in subscription.guard.ts L178–L217).
 *  3. Fetch the prior-month compliance report via `AttendanceService.getComplianceReport`.
 *  4. Filter defaulters: members where `attendanceRate !== null && attendanceRate < threshold`.
 *  5. If defaulters exist → dispatch via `DefaulterAlertService.dispatch`.
 *  6. Always write a `DefaulterAlertDispatch` row to prevent duplicate runs.
 *
 * Subscriptions are resolved in a single batched query before the per-workspace
 * loop — one `find($in)` instead of one `findOne` per workspace — to avoid N+1.
 *
 * Each workspace is processed in its own try/catch — one failure never aborts
 * the rest of the run.
 */
@Injectable()
export class DefaulterAlertCron {
  private readonly logger = new Logger(DefaulterAlertCron.name);
  private readonly tracer = trace.getTracer('attendance');

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(DefaulterAlertDispatch.name)
    private readonly dispatchModel: Model<DefaulterAlertDispatch>,
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
    private readonly attendanceService: AttendanceService,
    private readonly defaulterAlertService: DefaulterAlertService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  // ── Cron trigger ─────────────────────────────────────────────────────────

  /**
   * CRON CONTRACT - Monthly attendance defaulter alert
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    1st of each month 06:00 IST - alert HR/Manager on prior-month
   *              attendance defaulters.
   * Idempotent:  YES - per workspace, guarded by a DefaulterAlertDispatch
   *              {workspaceId, periodKey} row written every run; a re-run for the
   *              same closed month is skipped.
   * Reads:       workspaces, subscriptions, compliance report
   * Writes:      DefaulterAlertDispatch rows; sends in-app/email alerts
   * Missed run:  Self-heals - the next run still finds no dispatch row for the
   *              prior month and processes it.
   * Owner:       attendance
   */
  @Cron(CRON_SCHEDULES.MONTHLY_1ST_AT_6AM, {
    timeZone: CRON_TIMEZONES.IST,
    name: 'defaulter_alert',
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.DEFAULTER_ALERT, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    await this.tracer.startActiveSpan('attendance.defaulterAlertCron', async (span) => {
      const startedAt = Date.now();
      this.logger.log('DefaulterAlertCron: starting run');

      try {
        // Derive previous calendar month (the "closed" month to evaluate).
        const now = new Date();
        const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const month = prevMonthDate.getMonth() + 1; // 1–12
        const year = prevMonthDate.getFullYear();
        const periodKey = `${year}-${String(month).padStart(2, '0')}`;

        // Fetch all workspaces with defaulter alerts enabled.
        const workspaces = (await this.workspaceModel
          .find({ 'attendanceSettings.defaulterAlerts.enabled': true })
          .lean()
          .exec()) as WorkspaceLean[];

        if (workspaces.length === 0) {
          this.logger.log(
            `DefaulterAlertCron: no workspaces with defaulterAlerts.enabled=true — done`,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        span.setAttribute('workspaceCount', workspaces.length);

        this.logger.log(
          `DefaulterAlertCron: ${workspaces.length} workspace(s) to evaluate for period ${periodKey}`,
        );

        // ── Batch subscription lookup (Fix 3: eliminate N+1) ───────────────
        // Collect distinct ownerIds and resolve all active subscriptions in ONE
        // query. For owners with multiple rows, we keep the newest (`.sort({ createdAt: -1 })`
        // + first-per-userId logic below) — matching the guard's sort order.
        //
        // Status filter rationale (intentionally narrower than the read-guard):
        //   - 'active' / 'trial'  — clearly entitled.
        //   - 'cancelled'         — the period may not yet have lapsed; D1g keeps
        //                           reads open while `currentPeriodEnd` is still
        //                           in the future.  A write-side cron must not alert
        //                           on subscriptions that have already fully expired,
        //                           so we gate cancelled rows on currentPeriodEnd > now.
        //   - 'grace_period'      — the customer is in payment recovery; alerting
        //                           is still a write op but the subscription is
        //                           considered live per D1g policy.
        //   - 'expired'           — intentionally excluded; lapsed subscriptions
        //                           must not receive alert dispatches from a cron.
        const ownerIds = [...new Set(workspaces.map((ws) => ws.ownerId.toString()))];
        const nowForQuery = new Date();
        const rawSubs = (await this.subscriptionModel
          .find({
            userId: { $in: ownerIds.map((id) => new Types.ObjectId(id)) },
            $or: [
              { status: { $in: ['active', 'trial'] } },
              { status: 'cancelled', currentPeriodEnd: { $gt: nowForQuery } },
              { status: 'grace_period' },
            ],
          })
          .select('userId appliedEntitlements status currentPeriodEnd')
          .sort({ createdAt: -1 })
          .lean()
          .exec()) as SubscriptionLean[];

        // Build Map<ownerIdString, SubscriptionLean> — first entry wins (newest
        // due to the sort above, matching the guard's `.sort({ createdAt: -1 })`).
        const subByOwnerId = new Map<string, SubscriptionLean>();
        for (const sub of rawSubs) {
          const key = sub.userId.toString();
          if (!subByOwnerId.has(key)) {
            subByOwnerId.set(key, sub);
          }
        }

        let processed = 0;
        let skippedIdempotent = 0;
        let skippedEntitlement = 0;
        let errors = 0;

        for (const ws of workspaces) {
          try {
            const sub = subByOwnerId.get(ws.ownerId.toString());
            const result = await this.processWorkspace(ws, month, year, periodKey, sub);
            if (result === 'skipped_idempotent') skippedIdempotent++;
            else if (result === 'skipped_entitlement') skippedEntitlement++;
            else processed++;
          } catch (err: unknown) {
            errors++;
            this.logger.error(
              `DefaulterAlertCron: unhandled error for workspace ${ws._id.toString()}: ${err instanceof Error ? err.message : String(err)}`,
              err instanceof Error ? err.stack : undefined,
            );
            Sentry.captureException(err, {
              tags: { module: 'attendance', op: 'defaulter_alert_cron' },
            });
          }
        }

        const elapsed = Date.now() - startedAt;
        this.logger.log(
          `DefaulterAlertCron: run complete in ${elapsed}ms — ` +
            `processed=${processed} skippedIdempotent=${skippedIdempotent} ` +
            `skippedEntitlement=${skippedEntitlement} errors=${errors}`,
        );

        span.setAttributes({ processed, errors, skippedEntitlement, skippedIdempotent });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (outerErr: unknown) {
        span.recordException(outerErr as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (outerErr as Error)?.message,
        });
        Sentry.captureException(outerErr, {
          tags: { module: 'attendance', op: 'defaulter_alert_cron' },
        });
        this.logger.error(
          `DefaulterAlertCron: fatal outer error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`,
          outerErr instanceof Error ? outerErr.stack : undefined,
        );
        throw outerErr;
      } finally {
        span.end();
      }
    });
  }

  // ── Per-workspace handler ─────────────────────────────────────────────────

  /**
   * @param sub  Pre-fetched subscription lean doc for this workspace's owner,
   *             or `undefined` when none was found (batched in `run()`).
   */
  private async processWorkspace(
    ws: WorkspaceLean,
    month: number,
    year: number,
    periodKey: string,
    sub: SubscriptionLean | undefined,
  ): Promise<'processed' | 'skipped_idempotent' | 'skipped_entitlement'> {
    const wsId = ws._id.toString();

    // ── Step a: idempotency guard ─────────────────────────────────────────
    const existing = await this.dispatchModel
      .findOne({ workspaceId: ws._id, periodKey })
      .lean()
      .exec();

    if (existing) {
      this.logger.debug(
        `DefaulterAlertCron: workspace ${wsId} already processed for ${periodKey} — skipping`,
      );
      return 'skipped_idempotent';
    }

    // ── Step b: entitlement re-check ──────────────────────────────────────
    const entitled = this.hasDefaulterAlertEntitlement(sub);
    if (!entitled) {
      this.logger.log(
        `DefaulterAlertCron: workspace ${wsId} owner not entitled to defaulter_alerts — skipping`,
      );
      return 'skipped_entitlement';
    }

    // ── Step c: compliance report for the previous month ──────────────────
    const report = await this.attendanceService.getComplianceReport(wsId, month, year);
    const members: Array<{
      memberId: string;
      name: string;
      designation: string;
      attendanceRate: number | null;
    }> = report?.data?.members ?? [];

    // ── Step d: threshold ─────────────────────────────────────────────────
    const thresholdPct = ws.attendanceSettings?.complianceThresholdPct ?? 90;

    // ── Step e: filter defaulters — exclude null-rate members ─────────────
    const defaulters: DefaulterRow[] = members
      .filter((m) => m.attendanceRate !== null && m.attendanceRate < thresholdPct)
      .map((m) => ({
        memberId: m.memberId,
        name: m.name,
        designation: m.designation,
        attendanceRate: m.attendanceRate,
      }));

    // ── Step f: dispatch if defaulters exist ──────────────────────────────
    let recipientCount = 0;
    if (defaulters.length > 0) {
      const config = ws.attendanceSettings.defaulterAlerts;
      const result = await this.defaulterAlertService.dispatch({
        workspace: {
          _id: wsId,
          ownerId: ws.ownerId.toString(),
        },
        month,
        year,
        thresholdPct,
        defaulters,
        config: {
          channels: config.channels,
          recipients: {
            mode: config.recipients.mode,
            specificPeople: config.recipients.specificPeople.map((id) =>
              id instanceof Types.ObjectId ? id.toString() : String(id),
            ),
          },
        },
      });
      recipientCount = result.recipientCount;

      this.logger.log(
        `DefaulterAlertCron: dispatched for workspace ${wsId} — ` +
          `defaulters=${defaulters.length} recipients=${recipientCount}`,
      );
    } else {
      this.logger.log(
        `DefaulterAlertCron: workspace ${wsId} has no defaulters below ${thresholdPct}% for ${periodKey}`,
      );
    }

    // ── Step g: always record the dispatch row ────────────────────────────
    await this.dispatchModel.create({
      workspaceId: ws._id,
      periodKey,
      dispatchedAt: new Date(),
      defaulterCount: defaulters.length,
      recipientCount,
    });

    this.logger.debug(
      `DefaulterAlertCron: recorded dispatch row for workspace ${wsId} period ${periodKey}`,
    );

    return 'processed';
  }

  // ── Entitlement helper ────────────────────────────────────────────────────

  /**
   * Returns true if the pre-fetched subscription entitles
   * `attendance → defaulter_alerts`.
   *
   * Delegates to the pure `resolveSubFeatureAccess` util which mirrors
   * `subscription.guard.ts` §178–217 (including the legacy `modules[]`
   * fallback that the previous inline implementation omitted).
   *
   * @param sub  Pre-fetched subscription lean doc, or `undefined` when none
   *             was found for the workspace owner. Absence → denied.
   */
  private hasDefaulterAlertEntitlement(sub: SubscriptionLean | undefined): boolean {
    if (!sub) return false;

    const access = resolveSubFeatureAccess(
      sub.appliedEntitlements,
      ATTENDANCE_MODULE,
      DEFAULTER_ALERTS_SUBFEATURE,
    );

    return access !== FeatureAccessLevel.LOCKED;
  }
}
