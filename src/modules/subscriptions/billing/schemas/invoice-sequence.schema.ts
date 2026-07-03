import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Atomic per-fiscal-year counter for GST invoice numbers (D1f).
 *
 * One row per Indian fiscal year (Apr–Mar). `value` is incremented via
 * `findOneAndUpdate({ $inc: { value: 1 } }, { upsert: true, new: true })`
 * — Mongo guarantees atomicity at the document level, so concurrent
 * `nextInvoiceNumber` calls from any number of workers yield distinct
 * monotonically-increasing sequences within the FY.
 *
 * Numbers are formatted as `<PREFIX>-FY<YY>-<6-digit-zero-padded>` e.g.
 * `ZAR-FY26-000123`. The 6-digit pad gives 999_999 invoices per FY,
 * which is comfortably more than any single tenant will issue.
 *
 * GST law requires invoice numbers to be unique, sequential, and
 * unbroken within a fiscal year — this collection is the source of
 * truth that enforces all three.
 */
@Schema({ timestamps: true, collection: 'invoicesequences' })
export class InvoiceSequence extends Document {
  /** e.g. 'FY26' for the FY starting Apr 2026. Unique. */
  @Prop({ type: String, required: true, unique: true, index: true })
  fyKey: string;

  @Prop({ type: Number, default: 0 })
  value: number;
}

export const InvoiceSequenceSchema =
  SchemaFactory.createForClass(InvoiceSequence);
