import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * FiscalYear — per-firm record of an accounting period (D-12).
 *
 * Status transitions:
 *   OPEN  → CLOSED   (FyCloseService.close)
 *   CLOSED → REOPENED (FyCloseService.reopen)
 *   REOPENED → CLOSED (re-running close after edits)
 *
 * Auto-seeded on firm creation (Apr 1 → Mar 31 of current Indian FY) AND on
 * the first call to FiscalYearService.getCurrentFy() for legacy firms that
 * predate this phase.
 */
export interface FyAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: 'CLOSE' | 'REOPEN';
  reason?: string;
  ip?: string;
  userAgent?: string;
}

@Schema({ timestamps: true, collection: 'fiscalyears' })
export class FiscalYear extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  wsId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  startDate: Date;

  @Prop({ type: Date, required: true })
  endDate: Date;

  @Prop({
    type: String,
    enum: ['OPEN', 'CLOSED', 'REOPENED'],
    default: 'OPEN',
    index: true,
  })
  status: 'OPEN' | 'CLOSED' | 'REOPENED';

  @Prop({ type: Types.ObjectId })
  closedBy?: Types.ObjectId;

  @Prop({ type: Date })
  closedAt?: Date;

  @Prop({ type: Types.ObjectId })
  closingJournalId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  openingJournalId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  retainedEarningsAccountId?: Types.ObjectId;

  @Prop({
    type: [
      {
        at: { type: Date, required: true },
        by: { type: Types.ObjectId, required: true },
        action: { type: String, required: true },
        reason: { type: String },
        ip: { type: String },
        userAgent: { type: String },
      },
    ],
    default: [],
  })
  auditTrail: FyAuditEntry[];
}

export const FiscalYearSchema = SchemaFactory.createForClass(FiscalYear);
FiscalYearSchema.index({ wsId: 1, firmId: 1, status: 1 });
FiscalYearSchema.index(
  { wsId: 1, firmId: 1, startDate: 1 },
  { unique: true },
);
