import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { CreditNote } from '../../credit-notes/credit-note.schema';
import { DebitNote } from '../../debit-notes/debit-note.schema';
import { VoucherSeries } from '../../voucher-series/voucher-series.schema';
import { Firm } from '../../firms/firm.schema';
import { Party } from '../../parties/party.schema';

import { buildB2bSection } from './builders/b2b.builder';
import { buildB2clSection } from './builders/b2cl.builder';
import { buildB2csSection } from './builders/b2cs.builder';
import { buildCdnrSection } from './builders/cdnr.builder';
import { buildCdnurSection } from './builders/cdnur.builder';
import { buildHsnSection } from './builders/hsn.builder';
import { buildDocSection } from './builders/doc.builder';
import { buildNilSection } from './builders/nil.builder';
import { buildAtSection } from './builders/at.builder';
import { buildExpSection } from './builders/exp.builder';
import type { VerifyDataFinding } from '../verify-data/verify-data.schema';
import {
  checkC01Common,
  checkC02Common,
  checkC03Common,
  checkC05Common,
  checkC08Common,
  type CommonCheckDeps,
} from './checks/common';

// ─── Gstr1Report type ────────────────────────────────────────────────────────

export interface Gstr1Report {
  gstin: string;
  fp: string; // MMYYYY
  b2b: any[];
  b2cl: any[];
  b2cs: any[];
  cdnr: any[];
  cdnur: any[];
  hsn: { data: any[] };
  doc_issue: { doc_det: any[] };
  nil: { inv: any[] };
  at: any[]; // SEPARATE top-level key (D-05 requirement)
  atadj: any[]; // SEPARATE top-level key (D-05 requirement + T-12-W3-13 mitigation)
  exp: any[];
  _counts: {
    b2b: number;
    b2cl: number;
    b2cs: number;
    cdnr: number;
    cdnur: number;
    hsn: number;
    doc_issue: number;
    nil: number;
    at: number;
    atadj: number;
    exp: number;
  };
}

// ─── Gstr1Service ────────────────────────────────────────────────────────────

/**
 * Gstr1Service — GSTR-1 JSON composer + pre-flight validator.
 *
 * Methods:
 *  getReport(wsId, firmId, period)    → Gstr1Report with all 11 sections + _counts
 *  validatePeriod(wsId, firmId, period) → VerifyDataFinding[] from 5 pre-flight checks
 *  exportJson(wsId, firmId, period)   → { filename, payload } (payload strips _counts)
 *
 * All queries scoped by workspaceId + firmId (T-12-W3-08 cross-firm leak mitigation).
 * Builders called in parallel via Promise.all() (T-12-W3-10 performance).
 * at and atadj are SEPARATE top-level keys per CONTEXT D-05 (T-12-W3-13 mitigation).
 */
@Injectable()
export class Gstr1Service {
  // Platform-bar observability: shared finance tracer (mirrors Gstr3bService / SaleInvoiceService).
  // GSTR-1 is report generation (read/compute) so methods get spans only; there is no
  // request-scoped userId in these signatures, so no PostHog write event is emitted here.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(CreditNote.name) private readonly creditNoteModel: Model<CreditNote>,
    @InjectModel(DebitNote.name) private readonly debitNoteModel: Model<DebitNote>,
    @InjectModel(VoucherSeries.name) private readonly voucherSeriesModel: Model<VoucherSeries>,
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
  ) {}

  // ─── getReport ─────────────────────────────────────────────────────────────

  async getReport(wsId: string, firmId: string, period: string): Promise<Gstr1Report> {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstr1Report',
      { workspaceId: wsId, firmId, period },
      async () => {
        const { startDate, endDate } = this.periodBounds(period);

        const wsObjId = new Types.ObjectId(wsId);
        const firmObjId = new Types.ObjectId(firmId);

        const firm = await this.firmModel.findOne({ _id: firmObjId, workspaceId: wsObjId }).lean();

        const firmGstin: string = firm?.gstin ?? '';
        const firmStateCode: string = firmGstin ? firmGstin.slice(0, 2).padStart(2, '0') : '';

        const baseDeps = {
          saleInvoiceModel: this.saleInvoiceModel,
          creditNoteModel: this.creditNoteModel,
          debitNoteModel: this.debitNoteModel,
          voucherSeriesModel: this.voucherSeriesModel,
          advanceReceiptModel: undefined as any, // AdvanceReceipt schema not yet implemented — at.builder handles gracefully
          firmModel: this.firmModel,
          partyModel: this.partyModel,
          wsId: wsObjId,
          firmId: firmObjId,
          firmGstin,
          firmStateCode,
          startDate,
          endDate,
        };

        // Run all 10 builders in parallel — 9 produce independent sections; AT builder returns { at, atadj } pair
        const [b2b, b2cl, b2cs, cdnr, cdnur, hsn, doc_issue, nil, atPair, exp] = await Promise.all([
          buildB2bSection(baseDeps),
          buildB2clSection(baseDeps),
          buildB2csSection(baseDeps),
          buildCdnrSection(baseDeps),
          buildCdnurSection(baseDeps),
          buildHsnSection(baseDeps),
          buildDocSection(baseDeps),
          buildNilSection(baseDeps),
          buildAtSection(baseDeps), // returns { at, atadj }
          buildExpSection(baseDeps),
        ]);

        // CRITICAL: at and atadj are SEPARATE top-level keys per CONTEXT D-05
        const report: Gstr1Report = {
          gstin: firmGstin,
          fp: period,
          b2b,
          b2cl,
          b2cs,
          cdnr,
          cdnur,
          hsn,
          doc_issue,
          nil,
          at: atPair.at, // top-level "at" array
          atadj: atPair.atadj, // top-level "atadj" array
          exp,
          _counts: {
            b2b: b2b.length,
            b2cl: b2cl.length,
            b2cs: b2cs.length,
            cdnr: cdnr.length,
            cdnur: cdnur.length,
            hsn: hsn.data.length,
            doc_issue: doc_issue.doc_det.length,
            nil: nil.inv.length,
            at: atPair.at.length,
            atadj: atPair.atadj.length,
            exp: exp.length,
          },
        };

        return report;
      },
    );
  }

  // ─── validatePeriod ────────────────────────────────────────────────────────

  /**
   * validatePeriod — runs 5 pre-flight checks for the given period.
   *
   * Check implementations are CANONICAL in checks/common.ts.
   * Plan 12-06 (Wave 4 Verify-My-Data) imports and re-uses these same functions.
   * No duplicate implementation anywhere.
   */
  async validatePeriod(wsId: string, firmId: string, period: string): Promise<VerifyDataFinding[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.validateGstr1Period',
      { workspaceId: wsId, firmId, period },
      async () => {
        const { startDate, endDate } = this.periodBounds(period);

        const deps: CommonCheckDeps = {
          saleInvoiceModel: this.saleInvoiceModel,
          creditNoteModel: this.creditNoteModel,
          debitNoteModel: this.debitNoteModel,
          firmModel: this.firmModel,
          partyModel: this.partyModel,
          wsId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          startDate,
          endDate,
          now: new Date(),
        };

        const [f01, f02, f03, f05, f08] = await Promise.all([
          checkC01Common(deps),
          checkC02Common(deps),
          checkC03Common(deps),
          checkC05Common(deps),
          checkC08Common(deps),
        ]);

        return [...f01, ...f02, ...f03, ...f05, ...f08];
      },
    );
  }

  // ─── exportJson ────────────────────────────────────────────────────────────

  /**
   * exportJson — produces the GSTR-1 export payload.
   *
   * Strips the _counts field (UI-only). at and atadj remain as separate top-level keys.
   * Filename: GSTR1_{GSTIN}_{period}.json (T-12-W3-12 audit trail).
   */
  async exportJson(
    wsId: string,
    firmId: string,
    period: string,
  ): Promise<{ filename: string; payload: object }> {
    return withFinanceSpan(
      this.tracer,
      'finance.exportGstr1Json',
      { workspaceId: wsId, firmId, period },
      async () => {
        const report = await this.getReport(wsId, firmId, period);

        // Strip _counts (UI-only) — at and atadj remain as separate keys per D-05
        const { _counts, ...payload } = report;
        void _counts; // acknowledge intentional discard

        const filename = `GSTR1_${payload.gstin}_${period}.json`;
        return { filename, payload };
      },
    );
  }

  // ─── periodBounds ──────────────────────────────────────────────────────────

  private periodBounds(period: string): { startDate: Date; endDate: Date } {
    const month = parseInt(period.slice(0, 2), 10);
    const year = parseInt(period.slice(2), 10);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    return { startDate, endDate };
  }
}
