import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SmsDispatchStatus = 'sent' | 'failed' | 'skipped';

/**
 * Audit + accounting trail for every SMS dispatch attempt.
 *
 * Created by SmsService when a send is attempted (success OR fail OR skipped).
 * Powers:
 *   - per-workspace SMS spend dashboards
 *   - DLT-compliance audit (template_id + sender_id captured)
 *   - delivery-failure investigation (errorMessage + provider response)
 *   - credit-pack consumption tracking (Wave-3+ credit-pack model)
 *
 * `mobileMasked` stores the destination as e.g. "91XXXXXX1234" — last 4 digits
 * only — to satisfy DPDP / privacy minimisation.
 */
@Schema({ timestamps: true })
export class SmsDispatchLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  /**
   * Optional firm scope. Reminders dispatched per-firm carry firmId; one-off
   * platform messages (signup OTP etc.) leave firmId null.
   */
  @Prop({ type: Types.ObjectId, default: null })
  firmId: Types.ObjectId | null;

  /** Masked recipient number — never store full mobile in clear. */
  @Prop({ required: true })
  mobileMasked: string;

  /** Provider — currently 'msg91'. Allow others (twilio, plivo) later. */
  @Prop({ required: true, default: 'msg91' })
  provider: string;

  /** DLT-approved template ID (MSG91 flow_id). */
  @Prop({ required: true })
  templateId: string;

  /** DLT-approved sender ID (6 chars). */
  @Prop()
  senderId?: string;

  @Prop({
    required: true,
    type: String,
    enum: ['sent', 'failed', 'skipped'],
  })
  status: SmsDispatchStatus;

  /** Provider's response message-id (when sent successfully). */
  @Prop()
  providerMessageId?: string;

  /** Provider error or skip reason (truncated to 500 chars). */
  @Prop()
  errorMessage?: string;

  /** Number of credits consumed. Equals `segments` on success; 0 on skip. */
  @Prop({ default: 1 })
  creditsConsumed: number;

  // ── Wave 8 — segment-aware billing + cost tracking ──────────────────

  /**
   * Number of SMS segments this dispatch generated. GSM-7 splits at 160/153/153
   * chars; UCS-2 (Hindi/emoji) splits at 70/67/67. Customer is charged
   * `segments` credits per send. MSG91 is billed per-segment too — drives
   * `providerCostPaise` lookup.
   */
  @Prop({ default: 1 })
  segments: number;

  /** Encoding selected by `computeSegments()` — drives MSG91 cost-table lookup. */
  @Prop({ enum: ['GSM7', 'UCS2'], default: 'GSM7' })
  encoding: string;

  /** Country code (ISO-2) for cost-table lookup. */
  @Prop({ default: 'IN' })
  country: string;

  /**
   * Normalized provider error code (e.g. 'INVALID_NUMBER', 'DLT_TEMPLATE_REJECTED').
   * Drives auto-refund eligibility via the deterministic-error allowlist in
   * `SmsService.handleProviderFailure`. Lowercased provider strings are
   * mapped via a small switch in the service layer.
   */
  @Prop()
  errorCode?: string;

  /**
   * Whether the consumed credit was refunded after a deterministic provider
   * failure. Drives the "Refunded N credits this month" line on the credits
   * dashboard.
   */
  @Prop({ default: false })
  creditRefunded: boolean;

  /** Why the credit was refunded — short audit string. */
  @Prop()
  refundReason?: string;

  /**
   * Wholesale paise WE paid the provider for this dispatch. Sourced from
   * Msg91CostTable at send time (versioned per segments × encoding × country).
   * Powers per-workspace margin reports + monthly invoice reconciliation.
   * 0 for skipped / refunded sends.
   */
  @Prop({ default: 0 })
  providerCostPaise: number;

  /**
   * Optional reference to the entity that triggered this send — e.g. a
   * SaleInvoice ObjectId for a payment reminder, a Machine ObjectId for a
   * maintenance reminder. Lets ops trace from invoice → SMS log.
   */
  @Prop({ type: Types.ObjectId, default: null })
  entityRefId: Types.ObjectId | null;

  @Prop({ trim: true })
  entityRefType?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SmsDispatchLogSchema = SchemaFactory.createForClass(SmsDispatchLog);

SmsDispatchLogSchema.index({ workspaceId: 1, createdAt: -1 });
SmsDispatchLogSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
// Wave 8 — admin margin / refund-queue reports.
SmsDispatchLogSchema.index({ status: 1, errorCode: 1, createdAt: -1 });
SmsDispatchLogSchema.index({ creditRefunded: 1, createdAt: -1 });
