import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { LateFeeEntry } from './late-fee.schema';
import { LateFeeService } from './late-fee.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

@Injectable()
export class LateFeeAccrualCron {
  private readonly logger = new Logger(LateFeeAccrualCron.name);

  constructor(
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(LateFeeEntry.name) private readonly lateFeeModel: Model<LateFeeEntry>,
    private readonly lateFeeService: LateFeeService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Late-fee accrual
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 01:00 IST - accrue late fees on overdue posted invoices.
   * Idempotent:  YES - per invoice, guarded by LateFeeEntry.exists({invoiceId,
   *              accrualDate: today}) plus a unique-index E11000 catch. A re-run
   *              accrues nothing new for the same day.
   * Reads:       sale_invoices
   * Writes:      late_fee_entries (+ ledger via LateFeeService.postLateFeeEntry)
   * Missed run:  Self-heals - the next day accrues any still-missing day's fee.
   * Owner:       finance/payments
   */
  @Cron('0 1 * * *', { timeZone: 'Asia/Kolkata' })
  async handleAccrual(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_LATE_FEE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('Late-fee accrual cron started');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueInvoices = await this.saleInvoiceModel
      .find({
        state: 'posted',
        paymentStatus: { $in: ['unpaid', 'partial', 'overdue'] },
        dueDate: { $lt: today },
        lateFeeSchedule: { $exists: true, $ne: null },
        isDeleted: false,
      })
      .lean();

    this.logger.log(`Found ${overdueInvoices.length} overdue invoices to process`);
    let accrued = 0;
    let skipped = 0;

    for (const invoice of overdueInvoices) {
      try {
        // Dedup check: skip if already accrued today for this invoice
        const alreadyAccrued = await this.lateFeeModel.exists({
          invoiceId: invoice._id,
          accrualDate: today,
        });
        if (alreadyAccrued) {
          skipped++;
          continue;
        }

        const dueDate = invoice.dueDate ?? new Date(Date.now() - 30 * 86400000);
        const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / 86400000);
        const schedule = (invoice as any).lateFeeSchedule;
        const originalAmountPaise = (invoice as any).grandTotalPaise ?? 0;

        const feePaise = this.lateFeeService.computeLateFee(
          schedule,
          originalAmountPaise,
          daysPastDue,
        );
        if (feePaise <= 0) {
          skipped++;
          continue;
        }

        await this.lateFeeService.postLateFeeEntry(invoice as any, feePaise, today, daysPastDue);
        accrued++;
      } catch (err: any) {
        // E11000 duplicate key = already accrued (race condition) — log and continue
        if (err?.code === 11000) {
          skipped++;
        } else {
          this.logger.error(
            `Late-fee accrual failed for invoice ${String(invoice._id)}: ${err.message}`,
          );
        }
      }
    }

    this.logger.log(`Late-fee accrual complete: ${accrued} accrued, ${skipped} skipped`);
  }
}
