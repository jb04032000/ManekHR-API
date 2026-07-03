/**
 * Phase 17 / FIN-16 — Party Intelligence test fixtures.
 *
 * Used by:
 *   __tests__/integration/party-pnl.spec.ts (Plan 05)
 *   __tests__/unit/party-intelligence/rfm-segmenter.spec.ts (Plan 04)
 *
 * Pure helpers — no test framework imports. Consumers import these from
 * Vitest specs and call them on Mongoose models created via the
 * mongo-memory.ts harness.
 */

import { Types } from 'mongoose';
import type { Model } from 'mongoose';

/**
 * Seed N posted SaleInvoices for a party over a window ending `daysAgo` ago.
 * Each invoice is `Math.floor(totalPaise / invoiceCount)` paise.
 *
 * Returns the inserted invoice docs (lean, with _id).
 */
export async function seedPartyWithInvoices(
  invoiceModel: Model<any>,
  opts: {
    wsId: Types.ObjectId | string;
    firmId: Types.ObjectId | string;
    partyId: Types.ObjectId | string;
    invoiceCount: number;
    totalPaise: number;
    /** Days from today the most-recent invoice falls on. Default 0. */
    daysAgo?: number;
  },
): Promise<any[]> {
  const wsId = new Types.ObjectId(String(opts.wsId));
  const firmId = new Types.ObjectId(String(opts.firmId));
  const partyId = new Types.ObjectId(String(opts.partyId));
  const perInvoicePaise = Math.floor(opts.totalPaise / opts.invoiceCount);
  const baseDay = opts.daysAgo ?? 0;
  const now = Date.now();
  const docs: any[] = [];

  for (let i = 0; i < opts.invoiceCount; i++) {
    const voucherDate = new Date(now - (baseDay + i) * 86400_000);
    docs.push({
      workspaceId: wsId,
      firmId,
      partyId,
      voucherNumber: `INV-${String(i + 1).padStart(4, '0')}`,
      voucherDate,
      state: 'posted',
      financialYear: 'TEST',
      isDeleted: false,
      // Canonical schema fields (SaleInvoice has flat *Paise totals — Mongoose
      // strict-mode strips any unknown `totals` sub-doc on insertMany).
      taxableValuePaise: perInvoicePaise,
      grandTotalPaise: perInvoicePaise,
      // Pseudo `totals` retained for any consumer that prefers nested shape;
      // strict-mode drops it silently against the real SaleInvoice schema.
      totals: {
        netTaxableValue: perInvoicePaise,
        grandTotalPaise: perInvoicePaise,
      },
      lineItems: [],
      partySnapshot: { name: 'Fixture Party' },
    });
  }

  const inserted = await invoiceModel.insertMany(docs);
  return inserted.map((d: any) => d.toObject ? d.toObject() : d);
}

/**
 * Seed `sale_out` StockMovement rows linked to invoices, each carrying the
 * supplied `unitCostPaise` as `movingAvgCostPaise`. One movement per invoice
 * with qty = 1 (callers can override by passing `qtyPerInvoice`).
 */
export async function seedStockMovementsForInvoices(
  stockMovementModel: Model<any>,
  invoices: any[],
  opts: {
    unitCostPaise: number;
    qtyPerInvoice?: number;
    itemId?: Types.ObjectId | string;
  },
): Promise<any[]> {
  const qty = opts.qtyPerInvoice ?? 1;
  const itemId = opts.itemId
    ? new Types.ObjectId(String(opts.itemId))
    : new Types.ObjectId();
  const godownId = new Types.ObjectId();
  const createdBy = new Types.ObjectId();
  const docs = invoices.map((inv) => ({
    workspaceId: inv.workspaceId,
    firmId: inv.firmId,
    itemId,
    godownId,
    movementType: 'sale_out',
    qty: -Math.abs(qty), // sale_out is negative qty
    costPaise: opts.unitCostPaise,
    movingAvgCostPaise: opts.unitCostPaise,
    sourceVoucherType: 'sale_invoice',
    sourceVoucherId: inv._id,
    createdBy,
    occurredAt: inv.voucherDate,
  }));
  const inserted = await stockMovementModel.insertMany(docs);
  return inserted.map((d: any) => d.toObject ? d.toObject() : d);
}

/**
 * Seed a posted CreditNote linked to one invoice plus a corresponding
 * `credit_note_in` StockMovement carrying `unitCostPaise` * `returnQty`.
 *
 * Returns { creditNote, movement }.
 */
export async function seedCreditNote(
  creditNoteModel: Model<any>,
  stockMovementModel: Model<any>,
  opts: {
    invoice: any;
    returnQty: number;
    unitCostPaise: number;
    /** Net taxable revenue refunded (paise). Defaults to returnQty * unitCostPaise. */
    refundPaise?: number;
  },
): Promise<{ creditNote: any; movement: any }> {
  const refundPaise = opts.refundPaise ?? opts.returnQty * opts.unitCostPaise;
  const cnDate = new Date(opts.invoice.voucherDate.getTime() + 86400_000);
  const cnDoc = await creditNoteModel.create({
    workspaceId: opts.invoice.workspaceId,
    firmId: opts.invoice.firmId,
    partyId: opts.invoice.partyId,
    voucherNumber: `CN-${opts.invoice.voucherNumber}`,
    voucherDate: cnDate,
    state: 'posted',
    financialYear: 'TEST',
    isDeleted: false,
    sourceInvoiceId: opts.invoice._id,
    sourceInvoiceNumber: opts.invoice.voucherNumber ?? 'INV-FIXTURE',
    sourceInvoiceDate: opts.invoice.voucherDate,
    isIntraState: true,
    cdnrType: 'cdnr',
    cnType: 'goods_return',
    // Canonical schema fields (CreditNote has flat *Paise totals).
    taxableValuePaise: refundPaise,
    grandTotalPaise: refundPaise,
    totals: {
      netTaxableValue: refundPaise,
      grandTotalPaise: refundPaise,
    },
    lineItems: [],
  });

  const movDoc = await stockMovementModel.create({
    workspaceId: opts.invoice.workspaceId,
    firmId: opts.invoice.firmId,
    itemId: new Types.ObjectId(),
    godownId: new Types.ObjectId(),
    movementType: 'credit_note_in',
    qty: Math.abs(opts.returnQty),
    costPaise: opts.unitCostPaise,
    movingAvgCostPaise: opts.unitCostPaise,
    sourceVoucherType: 'credit_note',
    sourceVoucherId: cnDoc._id,
    createdBy: new Types.ObjectId(),
    occurredAt: cnDate,
  });

  return { creditNote: cnDoc.toObject(), movement: movDoc.toObject() };
}

/**
 * Compute the expected PartyPnlReport shape from raw inputs. Used for
 * assertion sites in party-pnl integration tests so the test arithmetic
 * lives next to the seeders.
 */
export function expectedPnl(opts: {
  revenuePaise: number;
  cogsPaise: number;
  invoiceCount: number;
  creditNoteCount?: number;
}) {
  const grossProfitPaise = opts.revenuePaise - opts.cogsPaise;
  const grossMarginPct =
    opts.revenuePaise > 0
      ? (grossProfitPaise / opts.revenuePaise) * 100
      : null;
  return {
    revenuePaise: opts.revenuePaise,
    cogsPaise: opts.cogsPaise,
    grossProfitPaise,
    grossMarginPct,
    invoiceCount: opts.invoiceCount,
    creditNoteCount: opts.creditNoteCount ?? 0,
    avgInvoiceValuePaise:
      opts.invoiceCount > 0
        ? Math.round(opts.revenuePaise / opts.invoiceCount)
        : 0,
  };
}
