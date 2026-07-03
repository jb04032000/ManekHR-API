/**
 * CommissionScheduleCron - Phase 3B scheduled commission dispatch.
 *
 * Fires on the 1st of each month at 08:00 IST (02:30 UTC). Iterates all
 * workspaces with commissionTracking enabled and dispatches any overdue
 * active CommissionSchedule entries via CommissionService.dispatchDueSchedules.
 *
 * The actual money (SalaryAdjustment rows) is written by CommissionService,
 * which is idempotent per (schedule, month, year). Re-runs of this cron are
 * safe: already-disbursed periods are skipped and logged.
 *
 * Workspace owner ID is used as the systemUserId for audit records to give
 * a traceable actor. This mirrors the payroll-auto-generate.cron.ts pattern
 * of using workspace.ownerId.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../schemas/payroll-config.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { CommissionService } from '../commission.service';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES, CronJobKey } from '../../../common/constants/cron.constants';

// 08:00 IST = 02:30 UTC. Run on the 1st of each month.
const COMMISSION_DISPATCH_SCHEDULE = '30 2 1 * *';

@Injectable()
export class CommissionScheduleCron {
  private readonly logger = new Logger(CommissionScheduleCron.name);

  constructor(
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly commissionService: CommissionService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Commission schedule dispatch (Phase 3B)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    1st of each month at 02:30 UTC (08:00 IST).
   * Idempotent:  YES - CommissionService.dispatchDueSchedules is idempotent per
   *              (schedule, month, year): an existing disbursementLog entry for
   *              the period is a no-op (verified in commission.service.ts), plus
   *              an atomic {workspaceId, scheduleId, month, year} guard.
   * Reads:       payroll_configs, workspaces
   * Writes:      salary adjustments (commission payouts) + disbursementLog
   * Missed run:  Self-heals - schedules stay "due" (nextDueMonth/Year <= now)
   *              until dispatched, so the next run picks them up.
   * Owner:       salary
   */
  @Cron(COMMISSION_DISPATCH_SCHEDULE, {
    timeZone: CRON_TIMEZONES.UTC,
  })
  async handleCommissionDispatch(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.COMMISSION_DISPATCH, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('Commission schedule dispatch cron started');

    try {
      // Find workspaces with commissionTracking enabled.
      const configs = await this.payrollConfigModel
        .find({ 'features.commissionTracking': true })
        .select('workspaceId')
        .lean()
        .exec();

      if (configs.length === 0) {
        this.logger.log('No workspaces with commissionTracking enabled; exiting');
        return;
      }

      this.logger.log(`Dispatching for ${configs.length} workspace(s)`);

      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'numeric',
      });
      const parts = formatter.formatToParts(now);
      const currentMonth = parseInt(parts.find((p) => p.type === 'month')?.value ?? '0', 10);
      const currentYear = parseInt(parts.find((p) => p.type === 'year')?.value ?? '0', 10);

      for (const config of configs) {
        const workspaceId = String(config.workspaceId);
        try {
          const workspace = await this.workspaceModel
            .findById(config.workspaceId)
            .select('ownerId name')
            .lean()
            .exec();

          if (!workspace) {
            this.logger.warn(`Workspace ${workspaceId} not found; skipping`);
            continue;
          }

          const systemUserId = String(workspace.ownerId);

          const result = await this.commissionService.dispatchDueSchedules(
            workspaceId,
            currentMonth,
            currentYear,
            systemUserId,
          );

          this.logger.log(
            `Commission dispatch for "${(workspace as any).name ?? workspaceId}": ` +
              `dispatched=${result.dispatched} skipped=${result.skipped} errors=${result.errors}`,
          );
        } catch (wsErr: unknown) {
          const msg = wsErr instanceof Error ? wsErr.message : String(wsErr);
          this.logger.error(`Commission dispatch failed for workspace ${workspaceId}: ${msg}`);
        }
      }

      this.logger.log('Commission schedule dispatch cron complete');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Commission dispatch cron error: ${msg}`, stack);
    }
  }
}
