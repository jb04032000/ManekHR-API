import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Refund policy — runtime-tunable rules controlling who can refund what.
 * Singleton document mirroring `BillingPolicy`. Admin panel edits this in
 * D1j to tighten or relax refunds without code changes.
 */
@Schema({ timestamps: true, collection: 'refundpolicies' })
export class RefundPolicy extends Document {
  @Prop({ type: String, required: true, unique: true, default: 'global' })
  scope: string;

  /**
   * If true, customers can self-service a full refund within the
   * `eligibleWithinDays` window. False = admin-only refunds.
   */
  @Prop({ default: false })
  customerSelfServiceEnabled: boolean;

  /**
   * How many days after capture a payment is eligible for refund.
   * Default 7. Use 0 for "no automatic refunds, admin discretion only".
   */
  @Prop({ default: 7 })
  eligibleWithinDays: number;

  /** Allow partial refunds. When false, only full refunds are accepted. */
  @Prop({ default: true })
  allowPartial: boolean;

  /**
   * Whether refunds against payments older than `eligibleWithinDays` need
   * a second admin's approval before processing.
   */
  @Prop({ default: true })
  requireSecondAdminApprovalAfterWindow: boolean;

  /** Pre-canned reasons surfaced in the admin refund dialog. */
  @Prop({
    type: [String],
    default: [
      'Customer request — within window',
      'Service outage compensation',
      'Billing error',
      'Duplicate charge',
      'Cancellation goodwill',
      'Other (specify in note)',
    ],
  })
  reasons: string[];

  /**
   * Whether the customer's plan should automatically downgrade to free
   * after a full refund of the most recent payment. When false, plan
   * remains active until the period ends.
   */
  @Prop({ default: false })
  autoDowngradeOnFullRefund: boolean;
}

export const RefundPolicySchema = SchemaFactory.createForClass(RefundPolicy);
