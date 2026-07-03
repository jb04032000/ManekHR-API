/**
 * Phase 17 / FIN-16-04 — Per-party direct-margin P&L (D-21..D-25).
 *
 * Reads canonical sources only:
 *   - Revenue  = Σ SaleInvoice.taxableValuePaise (state=posted, !isDeleted)
 *                − Σ CreditNote.taxableValuePaise (state=posted, partyId-scoped)
 *   - COGS     = Σ |qty| × movingAvgCostPaise on StockMovement rows where
 *                sourceVoucherType ∈ {sale_invoice, credit_note}
 *                (D-22 RESEARCH OVERRIDE — the per-line COGS snapshot field
 *                referenced by D-22 does NOT exist on SaleInvoice; never
 *                read SaleInvoiceLine cost fields.)
 *   - Service items / non-tracked items contribute 0 COGS automatically
 *     (no StockMovement row produced at sale time).
 *   - Pure refund credit notes (no inventory line) reduce revenue only;
 *     return credit notes carry a `credit_note_in` movement that subtracts
 *     proportionally from COGS (D-23).
 *
 * Mongoose 8.23 autocast guard (Pitfall 1): every ObjectId param is wrapped
 * with `new Types.ObjectId(...)` before use in a Mongoose query.
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';

export interface PartyPnlReport {
  partyId: string;
  partyName: string;
  periodFrom: Date;
  periodTo: Date;
  revenuePaise: number;
  cogsPaise: number;
  grossProfitPaise: number;
  /** null when revenuePaise === 0 (avoids divide-by-zero per D-21). */
  grossMarginPct: number | null;
  invoiceCount: number;
  creditNoteCount: number;
  avgInvoiceValuePaise: number;
}

@Injectable()
export class PartyPnlService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // partyDirectPnl is a read/compute report - span only, no PostHog.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel('SaleInvoice') private readonly invoiceModel: Model<any>,
    @InjectModel('CreditNote') private readonly creditNoteModel: Model<any>,
    @InjectModel('StockMovement') private readonly stockMovementModel: Model<any>,
    @InjectModel('Party') private readonly partyModel: Model<any>,
  ) {}

  /**
   * Direct-margin P&L for a single party over a closed date range.
   *
   * @param wsId    workspace ObjectId (string OK)
   * @param firmId  firm ObjectId (string OK)
   * @param partyId party ObjectId (string OK)
   * @param from    inclusive lower bound on voucherDate
   * @param to      inclusive upper bound on voucherDate
   */
  async partyDirectPnl(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    partyId: string | Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<PartyPnlReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.computePartyDirectPnl',
      {
        workspaceId: String(wsId),
        firmId: String(firmId),
        partyId: String(partyId),
      },
      () => this.partyDirectPnlImpl(wsId, firmId, partyId, from, to),
    );
  }

  private async partyDirectPnlImpl(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    partyId: string | Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<PartyPnlReport> {
    // Pitfall 1: Mongoose autocast does NOT reliably coerce string→ObjectId on
    // certain 8.x query shapes. Wrap explicitly at the read site.
    const wsOid = new Types.ObjectId(String(wsId));
    const firmOid = new Types.ObjectId(String(firmId));
    const partyOid = new Types.ObjectId(String(partyId));

    // 1. Revenue: posted, non-deleted SaleInvoices for partyId in window.
    const invoices = await this.invoiceModel
      .find({
        workspaceId: wsOid,
        firmId: firmOid,
        partyId: partyOid,
        state: 'posted',
        isDeleted: false,
        voucherDate: { $gte: from, $lte: to },
      })
      .lean()
      .maxTimeMS(30_000);
    const invoiceIds = invoices.map((i: any) => i._id);

    // 2. CreditNotes: posted, non-deleted, partyId in window.
    const credits = await this.creditNoteModel
      .find({
        workspaceId: wsOid,
        firmId: firmOid,
        partyId: partyOid,
        state: 'posted',
        isDeleted: false,
        voucherDate: { $gte: from, $lte: to },
      })
      .lean()
      .maxTimeMS(30_000);
    const creditIds = credits.map((c: any) => c._id);

    // Revenue per D-21: net taxable from invoices minus net taxable from CNs.
    // Schemas use flat `taxableValuePaise`; legacy fixtures sometimes carry a
    // `totals.netTaxableValue` — read both for resilience.
    const sumNet = (rows: any[]) =>
      rows.reduce(
        (s, r) =>
          s +
          (typeof r.taxableValuePaise === 'number'
            ? r.taxableValuePaise
            : (r.totals?.netTaxableValue ?? 0)),
        0,
      );
    const revenuePaise = sumNet(invoices) - sumNet(credits);

    // 3. COGS aggregations (RESEARCH OVERRIDE of D-22).
    //    Sale-out movements: sourceVoucherType='sale_invoice', movementType='sale_out'.
    let cogsAggSale: Array<{ cogsPaise: number }> = [];
    if (invoiceIds.length > 0) {
      cogsAggSale = await this.stockMovementModel
        .aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              sourceVoucherType: 'sale_invoice',
              sourceVoucherId: { $in: invoiceIds },
              movementType: 'sale_out',
            },
          },
          {
            $group: {
              _id: null,
              cogsPaise: {
                $sum: {
                  $multiply: [{ $abs: '$qty' }, '$movingAvgCostPaise'],
                },
              },
            },
          },
        ])
        .option({ maxTimeMS: 30_000 });
    }

    //    Credit-note return movements (proportional COGS reversal — D-23).
    let cogsAggReturn: Array<{ cogsBackPaise: number }> = [];
    if (creditIds.length > 0) {
      cogsAggReturn = await this.stockMovementModel
        .aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              sourceVoucherType: 'credit_note',
              sourceVoucherId: { $in: creditIds },
              movementType: 'credit_note_in',
            },
          },
          {
            $group: {
              _id: null,
              cogsBackPaise: {
                $sum: {
                  $multiply: [{ $abs: '$qty' }, '$movingAvgCostPaise'],
                },
              },
            },
          },
        ])
        .option({ maxTimeMS: 30_000 });
    }

    const cogsPaise = (cogsAggSale[0]?.cogsPaise ?? 0) - (cogsAggReturn[0]?.cogsBackPaise ?? 0);

    const grossProfitPaise = revenuePaise - cogsPaise;
    const grossMarginPct = revenuePaise > 0 ? (grossProfitPaise / revenuePaise) * 100 : null;

    // Resolve party name: prefer invoice snapshot, fall back to Party doc.
    let partyName: string =
      (invoices[0] as any)?.partySnapshot?.name ?? (credits[0] as any)?.partySnapshot?.name ?? '';
    if (!partyName) {
      const party = await this.partyModel.findOne({ _id: partyOid, workspaceId: wsOid }).lean();
      partyName = (party as any)?.name ?? '';
    }

    const invoiceCount = invoices.length;
    const avgInvoiceValuePaise = invoiceCount > 0 ? Math.round(revenuePaise / invoiceCount) : 0;

    return {
      partyId: String(partyOid),
      partyName,
      periodFrom: from,
      periodTo: to,
      revenuePaise,
      cogsPaise,
      grossProfitPaise,
      grossMarginPct,
      invoiceCount,
      creditNoteCount: credits.length,
      avgInvoiceValuePaise,
    };
  }
}
