import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PayrollConfig } from '../schemas/payroll-config.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { SalaryService } from '../salary.service';
import { LoanService } from '../loan.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../common/constants/cron.constants';

@Injectable()
export class PayrollAutoGenerateCron {
  private readonly logger = new Logger(PayrollAutoGenerateCron.name);

  constructor(
    @InjectModel(PayrollConfig.name)
    private payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<Workspace>,
    private salaryService: SalaryService,
    // LoanService injected here (not into SalaryService) to avoid a circular
    // dependency: SalaryService -> LoanService -> SalaryService. Both are
    // already provided by SalaryModule, so no new module wiring is needed.
    private loanService: LoanService,
    private notificationsService: NotificationsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Payroll auto-generate
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at 00:15 UTC - acts only on workspaces whose tz-local day
   *              is the 1st (per-workspace tz filter inside the handler).
   * Idempotent:  YES - per workspace, guarded by PayrollConfig.lastAutoGenerateKey
   *              === `<year>-<month>` (skips a month already generated); loan
   *              perquisites guard via perquisiteHistory. A re-run is a no-op.
   * Reads:       payroll_configs, workspaces
   * Writes:      salary records (generatePayroll), loan perquisites,
   *              PayrollConfig.lastAutoGenerateKey, owner notification
   * Missed run:  Self-heals - the next day re-checks; tz-day-1 workspaces not yet
   *              stamped for the month still get generated.
   * Owner:       salary
   */
  @Cron(CRON_SCHEDULES.PAYROLL_AUTO_GENERATE_SCHEDULE, {
    timeZone: CRON_TIMEZONES.UTC,
  })
  async handleAutoGenerate() {
    await this.singleFlight.runExclusive(CronJobKey.PAYROLL_AUTO_GENERATE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    this.logger.log('Running payroll auto-generate check...');

    try {
      const configs = await this.payrollConfigModel
        .find({ 'features.autoGenerate': true })
        .select('_id workspaceId lastAutoGenerateKey')
        .lean()
        .exec();

      if (configs.length === 0) {
        this.logger.log('No workspaces with autoGenerate enabled');
        return;
      }

      this.logger.log(`Found ${configs.length} workspaces with autoGenerate enabled`);

      for (const config of configs) {
        try {
          const workspaceId = String(config.workspaceId);
          const workspace = await this.workspaceModel
            .findById(config.workspaceId)
            .select('timezone name ownerId')
            .lean()
            .exec();

          if (!workspace) {
            this.logger.warn(`Workspace ${workspaceId} not found, skipping`);
            continue;
          }

          const timezone = workspace.timezone || 'Asia/Kolkata';
          const now = new Date();
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
          });
          const parts = formatter.formatToParts(now);
          const tzDay = parseInt(parts.find((part) => part.type === 'day')?.value || '0', 10);
          const tzMonth = parseInt(parts.find((part) => part.type === 'month')?.value || '0', 10);
          const tzYear = parseInt(parts.find((part) => part.type === 'year')?.value || '0', 10);

          if (tzDay !== 1) {
            continue;
          }

          const monthKey = `${tzYear}-${String(tzMonth).padStart(2, '0')}`;
          if (config.lastAutoGenerateKey === monthKey) {
            this.logger.debug(
              `Workspace ${workspaceId} already auto-generated for ${monthKey}, skipping`,
            );
            continue;
          }

          this.logger.log(
            `Auto-generating payroll for workspace "${workspace.name}" (${workspaceId}) — ${tzMonth}/${tzYear}`,
          );

          const records = await this.salaryService.generatePayroll(workspaceId, tzMonth, tzYear);

          // Auto-apply loan perquisites for the generated month so that
          // concessional/zero-rate loan phantom additions land on the salary
          // records immediately. computeMonthlyPerquisites is idempotent (it
          // guards via perquisiteHistory), so re-runs are safe.
          try {
            const perqResult = await this.loanService.computeMonthlyPerquisites(
              workspaceId,
              { month: tzMonth, year: tzYear },
              String(workspace.ownerId),
            );
            this.logger.log(
              `Loan perquisites computed for workspace "${workspace.name}": processed=${perqResult.processed} skippedIdempotent=${perqResult.skippedIdempotent} skippedExempt=${perqResult.skippedExempt} totalAmount=${perqResult.totalPerquisiteAmount}`,
            );
          } catch (perqError: unknown) {
            // Non-fatal: a perquisite failure must not abort the payroll run.
            const msg = perqError instanceof Error ? perqError.message : String(perqError);
            this.logger.warn(
              `Loan perquisite computation failed for workspace ${workspaceId} (${tzMonth}/${tzYear}): ${msg}`,
            );
          }

          await this.payrollConfigModel.updateOne(
            { _id: config._id },
            { $set: { lastAutoGenerateKey: monthKey } },
          );

          this.logger.log(
            `Generated ${records.length} salary records for workspace "${workspace.name}"`,
          );

          if (workspace.ownerId) {
            try {
              await this.notificationsService.createNotification(workspaceId, {
                recipientId: String(workspace.ownerId),
                title: 'Payroll Auto-Generated',
                message: `Salary records for ${tzMonth}/${tzYear} have been automatically generated for ${records.length} employee${records.length !== 1 ? 's' : ''}.`,
                type: 'success',
                metadata: {
                  kind: 'payroll_auto_generate',
                  month: tzMonth,
                  year: tzYear,
                  recordCount: records.length,
                },
              });
            } catch (notificationError) {
              this.logger.warn(
                `Failed to send notification for workspace ${workspaceId}: ${notificationError}`,
              );
            }
          }
        } catch (workspaceError: unknown) {
          const errorMessage =
            workspaceError instanceof Error ? workspaceError.message : 'Unknown error';
          this.logger.error(
            `Auto-generate failed for workspace ${String(config.workspaceId)}: ${errorMessage}`,
          );
        }
      }

      this.logger.log('Payroll auto-generate check complete');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Payroll auto-generate cron error: ${errorMessage}`, errorStack);
    }
  }
}
