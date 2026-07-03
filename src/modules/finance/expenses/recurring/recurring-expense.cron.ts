import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RecurringExpenseTemplate } from './recurring-expense-template.schema';
import { RecurringExpenseTemplateService } from './recurring-expense-template.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

@Injectable()
export class RecurringExpenseCron {
  private readonly logger = new Logger(RecurringExpenseCron.name);

  constructor(
    @InjectModel(RecurringExpenseTemplate.name)
    private readonly templateModel: Model<RecurringExpenseTemplate>,
    private readonly templateService: RecurringExpenseTemplateService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Recurring expense generation
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 06:00 IST - generate expense vouchers for due templates.
   * Idempotent:  PARTIAL - cursor-guarded: each template advances nextRunAt after
   *              a successful generate, so a normal re-run / next day does not
   *              re-generate. Residual gap: a crash between generate and the
   *              nextRunAt advance could double-generate on the next run (no
   *              per-(template, period) claim marker). Flagged in the plan's
   *              deferred section. Single-flight removes the multi-instance case.
   * Reads:       recurring_expense_templates
   * Writes:      expense vouchers; template cursor (nextRunAt/lastRunAt/runCount)
   * Missed run:  Self-heals - due templates stay due (nextRunAt <= now).
   * Owner:       finance/expenses
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM, { timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_RECURRING_EXPENSE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    const due = await this.templateModel.find({
      nextRunAt: { $lte: now },
      isActive: true,
      isDeleted: false,
    });

    this.logger.log(`Recurring expense cron: ${due.length} due template(s) found`);

    for (const tpl of due) {
      try {
        const systemUserId = (tpl.workspaceId as any).toHexString();
        await this.templateService.generateExpenseFromTemplate(tpl, systemUserId);

        tpl.lastRunAt = now;
        tpl.runCount += 1;
        tpl.nextRunAt = this.templateService.computeNextRun(tpl);

        if (tpl.schedule.endDate && tpl.nextRunAt > tpl.schedule.endDate) {
          tpl.isActive = false;
          this.logger.log(`Recurring expense ${String(tpl._id)} deactivated - endDate passed`);
        }
        await tpl.save();
      } catch (err: any) {
        // Log but do NOT advance nextRunAt - retried tomorrow.
        this.logger.error(
          `Recurring expense template ${String(tpl._id)} failed: ${String(err?.message)}`,
          err?.stack,
        );
      }
    }
  }
}
