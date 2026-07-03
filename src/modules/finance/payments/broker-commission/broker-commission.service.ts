import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types, ClientSession } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { BrokerCommissionEntry } from './broker-commission.schema';
import { PaymentReceipt, PaymentAllocation } from '../payment-receipt/payment-receipt.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { AccountsService } from '../../ledger/accounts.service';

const TDS_THRESHOLD_PAISE = 2_000_000;
const CODE_COMMISSION_PAYABLE = '5006';
const CODE_SUNDRY_CREDITORS = '2001';

/**
 * BrokerCommissionService — posts broker commission journal entries inside the
 * postPaymentReceipt() transaction (called after applyAllocations, before receipt.save()).
 *
 * One journal entry per receipt (aggregated across all broker-tagged allocations):
 *   Dr  Commission Payable (5006)  totalCommissionPaise
 *   Cr  Sundry Creditors   (2001)  totalCommissionPaise
 *
 * TDS flag: set tdsApplicable=true if cumulative commission to this broker in FY
 * exceeds ₹20,000 (₹2,000,000 paise). Actual TDS deduction journal is deferred to F-04.
 */
@Injectable()
export class BrokerCommissionService {
  private readonly logger = new Logger(BrokerCommissionService.name);
  // Platform-bar observability: shared finance tracer. Span only — this method
  // runs inside the postPaymentReceipt() transaction, which emits the PostHog event.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(BrokerCommissionEntry.name)
    private readonly commissionEntryModel: Model<BrokerCommissionEntry>,
    @InjectModel(SaleInvoice.name)
    private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,
    private readonly accountsService: AccountsService,
  ) {}

  /**
   * Called inside postPaymentReceipt() transaction after applyAllocations() and before receipt.save().
   * Only executes if receipt.brokerPartyId is set.
   * Creates ONE aggregated ledger entry per receipt to respect the unique (wsId, firmId, sourceVoucherId, sourceVoucherType) index.
   */
  async postCommission(
    receipt: PaymentReceipt,
    opts: { session?: ClientSession; userId: string },
  ): Promise<void> {
    const { session, userId } = opts;
    await withFinanceSpan(
      this.tracer,
      'finance.postBrokerCommission',
      {
        workspaceId: String(receipt.workspaceId),
        firmId: String(receipt.firmId),
        userId,
      },
      async () => {
        if (!receipt.brokerPartyId) return;

        const brokerPartyId = receipt.brokerPartyId;
        const financialYear = receipt.financialYear;
        const wsId = receipt.workspaceId;
        const firmId = receipt.firmId;
        const wsStr = wsId.toString();
        const firmStr = firmId.toString();

        // Pass 1 — compute per-allocation commissions, collect entries to persist
        const allocationResults: Array<{
          alloc: PaymentAllocation;
          commissionPaise: number;
          brokerCommissionPct: number;
          tdsApplicable: boolean;
        }> = [];

        let runningCumulative: number | null = null;

        for (const alloc of receipt.allocations) {
          const invoice = await this.saleInvoiceModel
            .findOne({ _id: alloc.invoiceId, workspaceId: wsId, firmId, isDeleted: false })
            .session(session ?? null)
            .exec();

          if (!invoice) {
            this.logger.warn(
              `BrokerCommissionService: invoice ${String(alloc.invoiceId)} not found — skipping`,
            );
            continue;
          }

          const brokerCommissionPct: number | undefined = (invoice as any).brokerCommissionPct;
          if (!brokerCommissionPct || brokerCommissionPct <= 0) continue;

          const commissionPaise = Math.round((alloc.allocatedPaise * brokerCommissionPct) / 100);
          if (commissionPaise <= 0) continue;

          // Lazy-load cumulative once per receipt call
          if (runningCumulative === null) {
            const agg = await this.commissionEntryModel
              .aggregate([
                { $match: { workspaceId: wsId, firmId, brokerPartyId, financialYear } },
                { $group: { _id: null, total: { $sum: '$commissionPaise' } } },
              ])
              .session(session ?? null);
            runningCumulative = agg[0]?.total ?? 0;
          }

          runningCumulative += commissionPaise;
          const tdsApplicable = runningCumulative > TDS_THRESHOLD_PAISE;

          allocationResults.push({ alloc, commissionPaise, brokerCommissionPct, tdsApplicable });
        }

        if (allocationResults.length === 0) return;

        // Pass 2 — create ONE aggregated ledger entry for the whole receipt
        const totalCommissionPaise = allocationResults.reduce((s, r) => s + r.commissionPaise, 0);

        const [commAcc, credAcc] = await Promise.all([
          this.accountsService.findByCode(wsStr, firmStr, CODE_COMMISSION_PAYABLE),
          this.accountsService.findByCode(wsStr, firmStr, CODE_SUNDRY_CREDITORS),
        ]);

        const ledgerEntry = new this.ledgerEntryModel({
          workspaceId: wsId,
          firmId,
          financialYear,
          entryDate: receipt.receiptDate,
          entryType: 'journal',
          sourceVoucherId: receipt._id,
          sourceVoucherType: 'broker_commission',
          sourceVoucherNumber: receipt.voucherNumber ?? '',
          narration: `Broker commission on receipt ${receipt.voucherNumber ?? String(receipt._id)}`,
          isReversed: false,
          lines: [
            {
              accountId: commAcc._id,
              accountCode: CODE_COMMISSION_PAYABLE,
              accountName: commAcc.name,
              debit: totalCommissionPaise,
              credit: 0,
              partyId: brokerPartyId,
            },
            {
              accountId: credAcc._id,
              accountCode: CODE_SUNDRY_CREDITORS,
              accountName: credAcc.name,
              debit: 0,
              credit: totalCommissionPaise,
              partyId: brokerPartyId,
            },
          ],
          postedBy: new Types.ObjectId(userId),
          postedAt: new Date(),
          auditLog: [],
        });

        const savedLedgerEntry = await ledgerEntry.save({ session });

        // Pass 3 — persist per-allocation audit records
        for (const {
          alloc,
          commissionPaise,
          brokerCommissionPct,
          tdsApplicable,
        } of allocationResults) {
          const commissionEntry = new this.commissionEntryModel({
            workspaceId: wsId,
            firmId,
            invoiceId: alloc.invoiceId,
            invoiceNumber: alloc.invoiceNumber,
            receiptId: receipt._id,
            brokerPartyId,
            commissionPaise,
            commissionRatePct: brokerCommissionPct,
            allocatedPaise: alloc.allocatedPaise,
            tdsApplicable,
            ledgerEntryId: savedLedgerEntry._id,
            financialYear,
          });
          await commissionEntry.save({ session });
        }

        this.logger.log(
          `Broker commission posted: ${totalCommissionPaise} paise total across ${allocationResults.length} allocation(s) — broker=${String(brokerPartyId)}`,
        );
      },
    );
  }
}
