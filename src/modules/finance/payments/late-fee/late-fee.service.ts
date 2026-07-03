import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { LateFeeEntry } from './late-fee.schema';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { AccountsService } from '../../ledger/accounts.service';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';

interface LateFeeSchedule {
  type: 'percentage_per_day' | 'flat_per_period';
  value: number; // rate% or flat paise
  gracePeriodDays: number;
}

@Injectable()
export class LateFeeService {
  private readonly logger = new Logger(LateFeeService.name);
  // Platform-bar observability: shared finance tracer. postLateFeeEntry is
  // cron-generated (no userId in signature) so it gets a span only, no PostHog event.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LateFeeEntry.name) private readonly lateFeeModel: Model<LateFeeEntry>,
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    private readonly accountsService: AccountsService,
    // D? consistency: late-fee accruals post through the central service (zero-sum invariant)
    // rather than writing a LedgerEntry directly.
    private readonly ledgerPosting: LedgerPostingService,
  ) {}

  /**
   * Compute late fee in paise.
   * Always uses originalAmountPaise (invoice.grandTotalPaise) as base — never amountDuePaise.
   * Simple interest only (no compounding per Indian trade convention — Vyapar/Tally pattern).
   */
  computeLateFee(
    schedule: LateFeeSchedule,
    originalAmountPaise: number,
    daysPastDue: number,
  ): number {
    const chargeDays = daysPastDue - schedule.gracePeriodDays;
    if (chargeDays <= 0) return 0;

    if (schedule.type === 'percentage_per_day') {
      // e.g. 18% p.a. → 0.18/365 per day
      const dailyRate = schedule.value / 100 / 365;
      return Math.round(originalAmountPaise * dailyRate);
    } else if (schedule.type === 'flat_per_period') {
      return Math.round(schedule.value); // flat paise per period
    }
    return 0;
  }

  async postLateFeeEntry(
    invoice: SaleInvoice,
    feePaise: number,
    accrualDate: Date,
    daysPastDue: number,
  ): Promise<LateFeeEntry> {
    const wsId = invoice.workspaceId.toHexString();
    const firmId = invoice.firmId.toHexString();
    return withFinanceSpan(
      this.tracer,
      'finance.postLateFeeEntry',
      { workspaceId: wsId, firmId, feePaise, daysPastDue },
      async () => {
        // Lookup accounts. Interest income routes to 4026 Vyaj Received for textile firms (D11),
        // falling back to 4006 Late Fee Income when 4026 isn't seeded (non-textile firms).
        const debtorsAccount = await this.accountsService.findByCode(wsId, firmId, '1003');
        const interestIncomeAccount = await this.resolveInterestIncomeAccount(wsId, firmId);

        // Route through the central posting service: Dr Sundry Debtors, Cr Late Fee / Vyaj income.
        // postManualJournal enforces the zero-sum invariant + builds the standard LedgerEntry, so
        // this cron accrual gets the same guarantees as every other posting.
        const entry = await this.ledgerPosting.postManualJournal(
          {
            workspaceId: invoice.workspaceId,
            firmId: invoice.firmId,
            financialYear:
              (invoice as any).financialYear ??
              `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
            entryDate: accrualDate,
            sourceVoucherId: invoice._id,
            sourceVoucherType: 'late_fee_accrual',
            sourceVoucherNumber: `LF-${(invoice as any).voucherNumber ?? invoice._id.toHexString().slice(-6)}`,
            narration: `Late fee accrued on ${(invoice as any).voucherNumber ?? invoice._id} for ${daysPastDue} days overdue`,
            lines: [
              {
                accountId: debtorsAccount._id,
                accountCode: '1003',
                accountName: 'Sundry Debtors',
                debit: feePaise,
                credit: 0,
                partyId: invoice.partyId,
              },
              {
                accountId: interestIncomeAccount._id,
                accountCode: interestIncomeAccount.code,
                accountName: interestIncomeAccount.name,
                debit: 0,
                credit: feePaise,
              },
            ],
          },
          // cron-generated: no real actor, so a fresh system ObjectId stands in for postedBy.
          { userId: new Types.ObjectId().toHexString() },
        );

        // Create LateFeeEntry record (dedup guard — unique index on invoiceId+accrualDate will reject duplicate)
        const lateFeeEntry = await this.lateFeeModel.create({
          workspaceId: invoice.workspaceId,
          firmId: invoice.firmId,
          invoiceId: invoice._id,
          invoiceNumber: (invoice as any).voucherNumber ?? invoice._id.toHexString(),
          partyId: invoice.partyId,
          accrualDate,
          feePaise,
          originalInvoiceAmountPaise: (invoice as any).grandTotalPaise,
          daysPastDue,
          ledgerEntryId: entry._id,
          financialYear:
            (invoice as any).financialYear ??
            `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
        });

        return lateFeeEntry;
      },
    );
  }

  // Interest/late-fee income account: 4026 Vyaj Received for textile firms (seeded), else 4006
  // Late Fee Income. Mirrors the job-work income-split fallback so non-textile firms (which only
  // have 4006) keep posting. Charging GST on interest (D11, on receipt) remains a separate flow.
  private async resolveInterestIncomeAccount(wsId: string, firmId: string) {
    try {
      return await this.accountsService.findByCode(wsId, firmId, '4026');
    } catch {
      return this.accountsService.findByCode(wsId, firmId, '4006');
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async signature kept; computation is synchronous
  async getLateFeeRegister(
    wsId: string,
    firmId: string,
    options: { partyId?: string; fromDate?: Date; toDate?: Date } = {},
  ): Promise<LateFeeEntry[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
    };
    if (options.partyId) filter.partyId = new Types.ObjectId(options.partyId);
    if (options.fromDate || options.toDate) {
      filter.accrualDate = {};
      if (options.fromDate) filter.accrualDate.$gte = options.fromDate;
      if (options.toDate) filter.accrualDate.$lte = options.toDate;
    }
    return this.lateFeeModel
      .find(filter)
      .sort({ accrualDate: -1 })
      .lean() as unknown as LateFeeEntry[];
  }
}
