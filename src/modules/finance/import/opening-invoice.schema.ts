import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OpeningInvoiceDocument = HydratedDocument<OpeningInvoice>;

/**
 * D19 entity 4: a pre-onboarding outstanding bill (bill-wise opening receivable), captured during
 * Tally/Excel onboarding. DELIBERATELY a separate collection from SaleInvoice so it can NEVER leak
 * into the 18 sales/GST/revenue reports that read SaleInvoice (no double-counted revenue, no GST).
 * The matching ledger entry (Dr Sundry Debtors with partyId, Cr 3004 Opening Equity) makes the
 * debtor-control balance - and therefore total AR - correct via the ledger. Bill-wise AR aging
 * reads this collection (follow-on wiring). No revenue, no GST: that was in the old books.
 */
@Schema({ collection: 'openinginvoices', timestamps: true })
export class OpeningInvoice {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  partyId: Types.ObjectId;

  @Prop({ type: String })
  partyName?: string;

  @Prop({ type: String, required: true })
  voucherNumber: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: Date })
  dueDate?: Date;

  @Prop({ type: Number, required: true })
  amountPaise: number;

  /** The opening AR ledger entry posted for this bill (Dr Debtors / Cr 3004). */
  @Prop({ type: Types.ObjectId })
  ledgerEntryId?: Types.ObjectId;

  @Prop({ type: String })
  financialYear?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export const OpeningInvoiceSchema = SchemaFactory.createForClass(OpeningInvoice);

// One opening bill per (firm, voucher number, party) - re-running the import won't duplicate.
OpeningInvoiceSchema.index(
  { workspaceId: 1, firmId: 1, partyId: 1, voucherNumber: 1 },
  { unique: true },
);
