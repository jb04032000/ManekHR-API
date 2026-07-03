import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RecurringInvoiceTemplate } from './recurring-template.schema';
import { RecurringInvoiceTemplateService } from './recurring-template.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

@Injectable()
export class RecurringInvoiceCron {
  private readonly logger = new Logger(RecurringInvoiceCron.name);

  constructor(
    @InjectModel(RecurringInvoiceTemplate.name)
    private readonly templateModel: Model<RecurringInvoiceTemplate>,
    private readonly templateService: RecurringInvoiceTemplateService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Recurring invoice generation
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 06:00 IST - generate sales invoices for due templates.
   * Idempotent:  PARTIAL - cursor-guarded: each template advances nextRunAt after
   *              a successful generate, so a normal re-run / next day does not
   *              re-generate. Residual gap: a crash between generate and the
   *              nextRunAt advance could double-generate on the next run (no
   *              per-(template, period) claim marker). Flagged in the plan's
   *              deferred section. Single-flight removes the multi-instance case.
   * Reads:       recurring_invoice_templates
   * Writes:      sales invoices; template cursor (nextRunAt/lastRunAt/runCount)
   * Missed run:  Self-heals - due templates stay due (nextRunAt <= now).
   * Owner:       finance/sales
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM, { timeZone: 'Asia/Kolkata' })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_RECURRING_INVOICE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    const now = new Date();
    const due = await this.templateModel.find({
      nextRunAt: { $lte: now },
      isActive: true,
      isDeleted: false,
    });

    this.logger.log(`Recurring cron: ${due.length} due template(s) found`);

    for (const tpl of due) {
      try {
        // Use workspaceId.toHexString() as system user fallback for cron-triggered runs
        // (real userId passed when triggerNow() is called from a controller)
        const systemUserId = (tpl.workspaceId as any).toHexString();
        await this.templateService.generateInvoiceFromTemplate(tpl, systemUserId);

        tpl.lastRunAt = now;
        tpl.runCount += 1;
        tpl.nextRunAt = this.templateService.computeNextRun(tpl);

        // Deactivate if endDate has passed
        if (tpl.schedule.endDate && tpl.nextRunAt > tpl.schedule.endDate) {
          tpl.isActive = false;
          this.logger.log(
            `Template ${String(tpl._id)} deactivated — endDate ${String(tpl.schedule.endDate)} passed`,
          );
        }

        await tpl.save();
        this.logger.debug(
          `Template ${String(tpl._id)} processed — nextRunAt: ${String(tpl.nextRunAt)}`,
        );
      } catch (err: any) {
        // Log error but do NOT advance nextRunAt — will retry tomorrow
        this.logger.error(
          `Recurring template ${String(tpl._id)} failed: ${err.message}`,
          err.stack,
        );
      }
    }
  }
}
