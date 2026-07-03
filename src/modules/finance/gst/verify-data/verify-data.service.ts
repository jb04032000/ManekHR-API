import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { CreditNote } from '../../credit-notes/credit-note.schema';
import { DebitNote } from '../../debit-notes/debit-note.schema';
import { GodownBalance } from '../../inventory/godown-balances/godown-balance.schema';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { Firm } from '../../firms/firm.schema';
import { Party } from '../../parties/party.schema';
import { VerifyDataResult } from './verify-data.schema';
import { GstRateHistoryService } from '../gst-rate-history/gst-rate-history.service';
import {
  CheckDeps,
  checkC01,
  checkC02,
  checkC03,
  checkC04,
  checkC05,
  checkC06,
  checkC07,
  checkC08,
  checkC09,
  checkC10,
  checkC11,
} from './checks';

/**
 * VerifyDataService — orchestrator for all 11 Verify-My-Data checks.
 *
 * Runs all 11 checks in parallel (Promise.all) for a given firm+period,
 * aggregates findings, and persists a VerifyDataResult document.
 *
 * Called by:
 *   - VerifyDataCronService (nightly 02:00 IST) with triggerType='cron'
 *   - VerifyDataController POST /run with triggerType='manual'
 *
 * GstRateHistoryService is injected and threaded into CheckDeps for C-11.
 */
@Injectable()
export class VerifyDataService {
  // Platform-bar observability: shared finance tracer (mirrors Gstr1Service / Gstr3bService).
  // runScan persists a VerifyDataResult (a write) and listResults reads -> both get spans.
  // No request-scoped userId flows into runScan (it takes triggerType, called by both the
  // controller and the nightly cron), so no PostHog write event is emitted (signature unchanged).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(SaleInvoice.name)
    private readonly saleInvoiceModel: Model<SaleInvoice>,

    @InjectModel(CreditNote.name)
    private readonly creditNoteModel: Model<CreditNote>,

    @InjectModel(DebitNote.name)
    private readonly debitNoteModel: Model<DebitNote>,

    @InjectModel(GodownBalance.name)
    private readonly godownBalanceModel: Model<GodownBalance>,

    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,

    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,

    @InjectModel(Party.name)
    private readonly partyModel: Model<Party>,

    @InjectModel(VerifyDataResult.name)
    private readonly resultModel: Model<VerifyDataResult>,

    private readonly gstRateHistoryService: GstRateHistoryService,
  ) {}

  /**
   * Run all 11 checks in parallel for a given firm+period and persist results.
   *
   * @param wsId - Workspace ID (string, converted to ObjectId internally)
   * @param firmId - Firm ID (string, converted to ObjectId internally)
   * @param period - Period in MMYYYY format (e.g. '042025')
   * @param triggerType - 'manual' (user-initiated) or 'cron' (nightly automated)
   * @returns Persisted VerifyDataResult document
   */
  async runScan(
    wsId: string,
    firmId: string,
    period: string,
    triggerType: 'manual' | 'cron',
  ): Promise<VerifyDataResult> {
    return withFinanceSpan(
      this.tracer,
      'finance.runVerifyDataScan',
      { workspaceId: wsId, firmId, period, triggerType },
      async () => {
        const { startDate, endDate } = this.periodBounds(period);
        const now = new Date();

        const deps: CheckDeps = {
          saleInvoiceModel: this.saleInvoiceModel,
          creditNoteModel: this.creditNoteModel,
          debitNoteModel: this.debitNoteModel,
          godownBalanceModel: this.godownBalanceModel,
          ledgerEntryModel: this.ledgerEntryModel,
          firmModel: this.firmModel,
          partyModel: this.partyModel,
          gstRateHistoryService: this.gstRateHistoryService,
          wsId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          period,
          startDate,
          endDate,
          now,
        };

        // Run all 11 checks in parallel (T-12-W4-01: parallel execution, not sequential)
        const [f01, f02, f03, f04, f05, f06, f07, f08, f09, f10, f11] = await Promise.all([
          checkC01(deps),
          checkC02(deps),
          checkC03(deps),
          checkC04(deps),
          checkC05(deps),
          checkC06(deps),
          checkC07(deps),
          checkC08(deps),
          checkC09(deps),
          checkC10(deps),
          checkC11(deps),
        ]);

        const findings = [
          ...f01,
          ...f02,
          ...f03,
          ...f04,
          ...f05,
          ...f06,
          ...f07,
          ...f08,
          ...f09,
          ...f10,
          ...f11,
        ];

        const errorCount = findings.filter((f) => f.severity === 'error').length;
        const warningCount = findings.filter((f) => f.severity === 'warning').length;

        // Persist new VerifyDataResult document (TTL on scannedAt = 90 days, Wave 1 schema)
        const result = await this.resultModel.create({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          period,
          scannedAt: now,
          triggerType,
          findings,
          errorCount,
          warningCount,
        });

        return result.toObject();
      },
    );
  }

  /**
   * List scan results for a firm, optionally filtered by period.
   * Returns the 50 most recent results (TTL-managed; oldest auto-purge after 90 days).
   */
  async listResults(wsId: string, firmId: string, period?: string): Promise<VerifyDataResult[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.listVerifyDataResults',
      { workspaceId: wsId, firmId, ...(period ? { period } : {}) },
      async () => {
        const filter: Record<string, any> = {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
        };
        if (period) filter.period = period;

        return this.resultModel.find(filter).sort({ scannedAt: -1 }).limit(50).lean() as Promise<
          VerifyDataResult[]
        >;
      },
    );
  }

  /**
   * Compute start/end dates from MMYYYY period string.
   * startDate = first day of the month (inclusive)
   * endDate = first day of the next month (exclusive, use $lt)
   */
  private periodBounds(period: string): { startDate: Date; endDate: Date } {
    const month = parseInt(period.slice(0, 2), 10);
    const year = parseInt(period.slice(2), 10);
    return {
      startDate: new Date(year, month - 1, 1),
      endDate: new Date(year, month, 1),
    };
  }
}
