import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * VerifyDataFinding — a single integrity issue found during a Verify-My-Data scan.
 *
 * checkId: unique identifier for the check category (e.g. 'C-01-missing-gstin').
 * severity: 'error' blocks filing; 'warning' is advisory.
 * fixRoute: deep-link route the user is sent to when they click "Fix" in the UI.
 * scannedAt: timestamp of this specific finding (matches VerifyDataResult.scannedAt).
 */
export interface VerifyDataFinding {
  checkId: string;
  severity: 'error' | 'warning';
  message: string;
  affectedDocType: string;
  affectedDocId: Types.ObjectId;
  affectedDocNo?: string;
  affectedPartyId?: Types.ObjectId;
  fixRoute: string;
  scannedAt: Date;
}

/**
 * VerifyDataResult — result of a single Verify-My-Data run.
 *
 * One document per scan run. TTL index auto-expires records after 90 days
 * (regulatory retention window — no PII beyond this point).
 *
 * triggerType: 'manual' = user-initiated; 'cron' = nightly automated scan.
 * period: 'MMYYYY' format, same as Gstr3bAdjustment.period.
 */
@Schema({ timestamps: true })
export class VerifyDataResult extends Document {
  @Prop({ type: Types.ObjectId, required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  /** Period scanned in 'MMYYYY' format, e.g. '042025' = April 2025. */
  @Prop({ type: String, required: true })
  period: string;

  /** Timestamp when this scan was executed. Also used as the TTL field. */
  @Prop({ type: Date, required: true })
  scannedAt: Date;

  /** How the scan was triggered. */
  @Prop({ type: String, enum: ['manual', 'cron'], required: true })
  triggerType: string;

  /** All findings from this scan run. */
  @Prop({ type: Array, default: [] })
  findings: VerifyDataFinding[];

  /** Count of error-severity findings (denormalized for quick dashboard display). */
  @Prop({ type: Number, default: 0 })
  errorCount: number;

  /** Count of warning-severity findings (denormalized for quick dashboard display). */
  @Prop({ type: Number, default: 0 })
  warningCount: number;
}

export const VerifyDataResultSchema = SchemaFactory.createForClass(VerifyDataResult);

// Lookup index: list scan results for a given period, newest first
VerifyDataResultSchema.index({ workspaceId: 1, firmId: 1, period: 1, scannedAt: -1 });

// TTL index: auto-expire scan results after 90 days (T-12-W1-03 privacy mitigation)
VerifyDataResultSchema.index(
  { scannedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 3600 },
);
