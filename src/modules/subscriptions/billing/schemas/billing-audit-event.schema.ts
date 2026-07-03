import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Append-only audit log for billing state changes (D1k).
 *
 * One row per mutation across the billing surface — admin actions,
 * customer self-serve actions, system-triggered automations (dunning
 * cron), and webhook-triggered transitions. Becomes the single source
 * of truth for "who changed what when" investigations and downstream
 * compliance / SOC2-style reporting.
 *
 * Schema design:
 *   - `action` is a flat dotted string (`admin.grant`,
 *     `self.refund_request`, `webhook.subscription_charged`) instead
 *     of a tight enum so new actions can be added without a schema
 *     migration. Convention enforced at service-layer constants.
 *   - `actorType` enumerated for fast filtering of "what did admins
 *     do" / "what did customers do" / "what auto-fired".
 *   - `metadata` is a free-form sparse object with a small typed
 *     surface (diff, reason, amountPaise) — kept lean to avoid
 *     ballooning collection size at scale.
 *   - Append-only — no updates, no deletes. Index supports the
 *     common admin query "show me all events for this user / this
 *     subscription / this payment in date range".
 *
 * Failure mode: the AuditLogService never throws upstream — if the
 * insert fails (Mongo down, validation error), the original action
 * still succeeds and the failure is logged via the Nest logger. We
 * accept temporary audit gaps over breaking the user-facing path.
 */
@Schema({ timestamps: { createdAt: 'occurredAt', updatedAt: false }, collection: 'billingauditevents' })
export class BillingAuditEvent extends Document {
  /**
   * Dotted-string action key. Convention:
   *   <actorType>.<verb>[_<noun>]
   * Examples: `admin.grant`, `admin.entitlement_override`,
   * `self.refund_request`, `webhook.subscription_charged`,
   * `system.dunning_grace_expired`.
   */
  @Prop({ type: String, required: true, index: true })
  action: string;

  @Prop({
    type: String,
    enum: ['admin', 'self', 'system', 'webhook'],
    required: true,
    index: true,
  })
  actorType: string;

  /** User id of the admin OR customer who triggered the action. Null for system/webhook. */
  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  actorUserId?: Types.ObjectId;

  /**
   * The customer this event affects. For admin actions this is the
   * target customer; for self-serve it equals actorUserId; for
   * webhooks it's the customer behind the gateway entity.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  targetUserId?: Types.ObjectId;

  /** Affected subscription (if applicable). */
  @Prop({ type: Types.ObjectId, ref: 'Subscription', index: true, sparse: true })
  subscriptionId?: Types.ObjectId;

  /** Affected payment row (if applicable). */
  @Prop({
    type: Types.ObjectId,
    ref: 'SubscriptionPayment',
    index: true,
    sparse: true,
  })
  paymentId?: Types.ObjectId;

  /** Affected refund request (if applicable). */
  @Prop({
    type: Types.ObjectId,
    ref: 'RefundRequest',
    sparse: true,
  })
  refundRequestId?: Types.ObjectId;

  /** Affected plan (e.g. for custom-plan CRUD events). */
  @Prop({ type: Types.ObjectId, ref: 'Plan', sparse: true })
  planId?: Types.ObjectId;

  /** Affected coupon (e.g. for coupon CRUD events). */
  @Prop({ type: Types.ObjectId, ref: 'Coupon', sparse: true })
  couponId?: Types.ObjectId;

  /**
   * Free-form metadata bag. Conventional keys:
   *   - reason: string — why the action happened (admin-supplied)
   *   - before / after: small diff snapshots
   *   - amountPaise: number — for refund / payment events
   *   - status: string — for state transitions
   *   - durationDays / additionalDays / etc — action-specific scalars
   */
  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  /** Caller IP (when available — set by service from request context). */
  @Prop({ type: String })
  ipAddress?: string;

  /** Caller User-Agent. */
  @Prop({ type: String })
  userAgent?: string;
}

export const BillingAuditEventSchema =
  SchemaFactory.createForClass(BillingAuditEvent);

// Hot path: admin queries by target user + date range.
BillingAuditEventSchema.index({ targetUserId: 1, occurredAt: -1 });
// Hot path: admin queries by actor + date range.
BillingAuditEventSchema.index({ actorUserId: 1, occurredAt: -1 });
// Hot path: subscription history view.
BillingAuditEventSchema.index({ subscriptionId: 1, occurredAt: -1 });
// Hot path: payment history view.
BillingAuditEventSchema.index({ paymentId: 1, occurredAt: -1 });
// Hot path: action-type filter.
BillingAuditEventSchema.index({ action: 1, occurredAt: -1 });
