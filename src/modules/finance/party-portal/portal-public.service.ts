import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
// Platform-bar observability: span-ONLY for the public token-based reads. This is the
// unauthenticated customer portal - there is no userId, so NO PostHog here, and span
// attributes carry partyId/firmId only (never the portal token, scope secrets, or PII).
import { withFinanceSpan } from '../common/finance-observability';
import { Firm } from '../firms/firm.schema';
import { Party } from '../parties/party.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../sales/sale-invoice/sale-invoice.schema';
import { PaymentReceipt } from '../payments/payment-receipt/payment-receipt.schema';
import { PartyLedgerService } from '../reports/services/party-ledger.service';
import type { PortalContext } from './portal-token.service';

export interface PortalContextPayload {
  // View-only portal (owner decision 2026-06-06, feedback_no_payments_in_billing):
  // no payment fields are exposed - no upiVpa, no pay path. The portal shows
  // statement / invoices / receipts / aging only.
  firm: {
    name: string;
    logo?: string;
    primaryColor?: string;
  };
  party: { name: string };
  outstanding: number;
  /** The token's granted scopes — the web shell renders only permitted tabs. */
  scope: string[];
}

/**
 * PortalPublicService — read-only data shaping for the customer portal.
 *
 * `getContext()` aggregates the firm header, party header, and outstanding
 * (debit − credit on party-scoped LedgerEntry lines, paise integer) so the
 * portal's first paint can render a hero card without N+1 calls.
 *
 * Outstanding aggregation mirrors PartyLedgerService.getPartyStatement —
 * unwind `lines`, match `lines.partyId`, sum debit/credit (paise). Single
 * source of truth for sign convention: positive = receivable owed by party.
 */
@Injectable()
export class PortalPublicService {
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name)
    private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(PaymentReceipt.name)
    private readonly receiptModel: Model<PaymentReceipt>,
    private readonly partyLedger: PartyLedgerService,
  ) {}

  /**
   * Enforces the token's `scope` for a portal read. Each shareable link is
   * issued with a scope (e.g. ['statement'] only); the link must never expose a
   * resource the owner did not grant. Throws 403 when the scope is absent.
   * SEC-1: least-privilege enforcement on the unauthenticated customer portal.
   * (Cross-PARTY isolation is separately guaranteed by deriving partyId from the
   * verified token and filtering every query on it — never from request input.)
   */
  private assertScope(ctx: PortalContext, required: string): void {
    if (!ctx.scope?.includes(required)) {
      throw new ForbiddenException(`This portal link does not include ${required} access.`);
    }
  }

  async getContext(ctx: PortalContext): Promise<PortalContextPayload> {
    return withFinanceSpan(
      this.tracer,
      'finance.portalGetContext',
      { firmId: ctx.firmId, partyId: ctx.partyId },
      () => this.getContextImpl(ctx),
    );
  }

  private async getContextImpl(ctx: PortalContext): Promise<PortalContextPayload> {
    const wsOid = new Types.ObjectId(ctx.wsId);
    const firmOid = new Types.ObjectId(ctx.firmId);
    const partyOid = new Types.ObjectId(ctx.partyId);

    const firm = await this.firmModel.findOne({ _id: firmOid, workspaceId: wsOid }).lean();
    if (!firm) throw new NotFoundException('Firm not found');

    const party = await this.partyModel
      .findOne({ _id: partyOid, workspaceId: wsOid, firmId: firmOid })
      .lean();
    if (!party) throw new NotFoundException('Party not found');

    // Outstanding: sum(debit) - sum(credit) on party-scoped ledger lines,
    // paise integer. Mirrors PartyLedgerService.getPartyStatement.
    const agg = await this.ledgerModel.aggregate([
      {
        $match: {
          workspaceId: wsOid,
          firmId: firmOid,
          isReversed: { $ne: true },
        },
      },
      { $unwind: '$lines' },
      { $match: { 'lines.partyId': partyOid } },
      {
        $group: {
          _id: null,
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ]);
    const debit = agg[0]?.debit ?? 0;
    const credit = agg[0]?.credit ?? 0;
    const outstanding = debit - credit;

    const brand: any = (firm as any).brandProfile ?? {};

    return {
      firm: {
        name: (firm as any).firmName ?? '',
        logo: brand.logoUrl ?? brand.logo ?? undefined,
        primaryColor: brand.primaryColor ?? brand.brandPrimary ?? undefined,
      },
      party: { name: (party as any).name ?? '' },
      outstanding,
      scope: ctx.scope ?? [],
    };
  }

  /**
   * Statement: full ledger statement for the party for current FY (Apr 1 →
   * Mar 31 by default). Delegates to PartyLedgerService.getPartyStatement.
   */
  async getStatementForParty(ctx: PortalContext) {
    this.assertScope(ctx, 'statement');
    return withFinanceSpan(
      this.tracer,
      'finance.portalGetStatement',
      { firmId: ctx.firmId, partyId: ctx.partyId },
      async () => {
        const today = new Date();
        const y = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
        const dateFrom = new Date(Date.UTC(y, 3, 1, 0, 0, 0, 0));
        const dateTo = new Date(Date.UTC(y + 1, 2, 31, 23, 59, 59, 999));
        return this.partyLedger.getPartyStatement(
          ctx.wsId,
          ctx.firmId,
          ctx.partyId,
          dateFrom,
          dateTo,
        );
      },
    );
  }

  /**
   * Invoices: paginated SaleInvoice list for the party only — cross-party
   * isolation enforced via filter on partyId.
   */
  async getInvoicesForParty(ctx: PortalContext, page = 1, limit = 20) {
    this.assertScope(ctx, 'invoices');
    return withFinanceSpan(
      this.tracer,
      'finance.portalGetInvoices',
      { firmId: ctx.firmId, partyId: ctx.partyId, page, limit },
      async () => {
        const wsOid = new Types.ObjectId(ctx.wsId);
        const firmOid = new Types.ObjectId(ctx.firmId);
        const partyOid = new Types.ObjectId(ctx.partyId);
        const filter = {
          workspaceId: wsOid,
          firmId: firmOid,
          partyId: partyOid,
          state: 'posted',
          isDeleted: { $ne: true },
        };
        const skip = (Math.max(1, page) - 1) * limit;
        const [data, total] = await Promise.all([
          this.invoiceModel
            .find(filter)
            .sort({ voucherDate: -1 })
            .skip(skip)
            .limit(limit)
            .select(
              'voucherNumber voucherDate state paymentStatus grandTotalPaise amountDuePaise paymentTerms',
            )
            .lean(),
          this.invoiceModel.countDocuments(filter),
        ]);
        return { data, total, page, limit };
      },
    );
  }

  /**
   * Asserts a SaleInvoice belongs to the portal-context's party. Throws
   * 404 NotFoundException otherwise — never leak a different party's
   * invoice (cross-party IDOR mitigation, T-16-04-03).
   */
  async assertInvoiceBelongsToParty(ctx: PortalContext, invoiceId: string): Promise<any> {
    this.assertScope(ctx, 'invoices');
    return withFinanceSpan(
      this.tracer,
      'finance.portalAssertInvoice',
      { firmId: ctx.firmId, partyId: ctx.partyId, invoiceId },
      async () => {
        const inv = await this.invoiceModel
          .findOne({
            _id: new Types.ObjectId(invoiceId),
            workspaceId: new Types.ObjectId(ctx.wsId),
            firmId: new Types.ObjectId(ctx.firmId),
            partyId: new Types.ObjectId(ctx.partyId),
            isDeleted: { $ne: true },
          })
          .lean();
        if (!inv) throw new NotFoundException('Invoice not found');
        return inv;
      },
    );
  }

  /**
   * Receipts: payments received from the party (state='posted').
   */
  async getReceiptsForParty(ctx: PortalContext) {
    this.assertScope(ctx, 'receipts');
    return withFinanceSpan(
      this.tracer,
      'finance.portalGetReceipts',
      { firmId: ctx.firmId, partyId: ctx.partyId },
      async () => {
        const wsOid = new Types.ObjectId(ctx.wsId);
        const firmOid = new Types.ObjectId(ctx.firmId);
        const partyOid = new Types.ObjectId(ctx.partyId);
        const data = await this.receiptModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            partyId: partyOid,
            state: 'posted',
            isDeleted: { $ne: true },
          })
          .sort({ receiptDate: -1 })
          .select('voucherNumber receiptDate paymentMode referenceNo totalAmountPaise')
          .lean();
        return { data };
      },
    );
  }

  /**
   * Aging: standard 0-30 / 31-60 / 61-90 / 90+ buckets for this party
   * derived from PartyLedgerService.getReceivablesAging filtered down.
   */
  async getAgingForParty(ctx: PortalContext) {
    this.assertScope(ctx, 'statement');
    return withFinanceSpan(
      this.tracer,
      'finance.portalGetAging',
      { firmId: ctx.firmId, partyId: ctx.partyId },
      async () => {
        const all = await this.partyLedger.getReceivablesAging(ctx.wsId, ctx.firmId);
        const row = all.rows.find((r) => r.partyId === String(ctx.partyId)) ?? {
          partyId: ctx.partyId,
          partyName: '',
          current: 0,
          b0_30: 0,
          b31_60: 0,
          b61_90: 0,
          b90plus: 0,
          total: 0,
        };
        return row;
      },
    );
  }
}
