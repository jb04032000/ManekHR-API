import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Plan, PlanEntitlements } from './plan.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Subscription extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: User | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Plan', required: true })
  planId: Plan | Types.ObjectId;

  @Prop({
    enum: [
      'active',
      'cancelled',
      'expired',
      'trial',
      'superseded',
      'scheduled',
      'paused',
      'past_due',
      'grace_period',
      // D1c: mandate created on Razorpay, awaiting auth-payment completion.
      // Distinct from 'scheduled' (user-chosen future activation) — pending
      // means the gateway is mid-flow. Survives the existing partial-unique
      // indexes on (userId, status) since 'pending' is in neither set.
      'pending',
    ],
    default: 'trial',
  })
  status: string;

  @Prop({ enum: ['monthly', 'yearly', 'lifetime'], default: 'monthly' })
  billingCycle: string;

  /**
   * Workspace this subscription is bound to. Null = account-level (covers
   * every workspace the user owns). Set = workspace-level (admin assigned).
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  workspaceId?: Types.ObjectId | null;

  /**
   * Product line this subscription belongs to, denormalized from the plan at
   * subscribe time so the unique indexes can scope per product. This is what
   * lets one person hold an active ERP subscription AND an active Connect
   * subscription simultaneously (they differ on `product`).
   */
  @Prop({ type: String, enum: ['erp', 'connect', 'bundle'], default: 'erp', required: true })
  product: string;

  @Prop()
  currentPeriodStart?: Date;

  @Prop()
  currentPeriodEnd?: Date;

  @Prop({ type: Object, required: true })
  purchasedEntitlements: PlanEntitlements;

  @Prop({ type: Object, required: true })
  appliedEntitlements: PlanEntitlements;

  @Prop()
  cancelledAt?: Date;

  @Prop({ type: String })
  cancellationReason?: string;

  /**
   * Source of the activation. Tracks how a subscription came into being for
   * audit + reporting:
   *   - self            : user paid via self-serve checkout
   *   - admin           : admin force-grant (no payment)
   *   - manual_payment  : admin recorded an offline payment (NEFT/cheque/etc.)
   *   - paid_link       : admin issued a payment link, user paid via link
   *   - trial           : trial activation (no payment yet)
   *   - migrated        : auto-created during a tier migration / upgrade
   */
  @Prop({
    enum: ['self', 'admin', 'manual_payment', 'paid_link', 'trial', 'migrated'],
    default: 'self',
  })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedBy?: User | Types.ObjectId;

  @Prop({ optional: true })
  assignedAt?: Date;

  @Prop({ optional: true })
  assignmentNote?: string;

  @Prop({ type: Types.ObjectId, ref: 'Subscription', optional: true })
  previousSubscriptionId?: Subscription | Types.ObjectId;

  @Prop({ default: false }) hasActiveAddOns: boolean;

  @Prop({ default: false }) adminEntitlementOverride: boolean;

  // ── Razorpay handles ────────────────────────────────────────────────
  /** Razorpay order id from one-time checkout. */
  @Prop({ type: String, index: true })
  razorpayOrderId?: string;

  /** Razorpay payment id once captured. Used for idempotent confirm. */
  @Prop({ type: String, index: true })
  razorpayPaymentId?: string;

  /**
   * Razorpay subscription id when using auto-renew mandates (D1c).
   * Unique-sparse — corruption guard ensuring two local Subscriptions
   * never point at the same Razorpay sub id (would corrupt webhook
   * routing). Sparse so the index ignores null/missing for one-time +
   * trial subs that have no mandate.
   */
  @Prop({ type: String, index: true, unique: true, sparse: true })
  razorpaySubscriptionId?: string;

  // ── Trial state ─────────────────────────────────────────────────────
  @Prop()
  trialEndsAt?: Date;

  // Set once when a trial lapses and the account downgrades to its base plan (Phase 4 downgrade). Drives the web post-expiry 'your trial ended' banner. NOT cleared on downgrade; cleared only if the account re-upgrades to a paid/trial state.
  @Prop({ type: Date, default: null })
  trialEndedAt: Date | null;

  /** Whether the trial required a card up-front. Locked at activation time. */
  @Prop({ default: false })
  trialCardRequired: boolean;

  // ── Dunning + grace ─────────────────────────────────────────────────
  /** Until this date the plan is read-only after a failed renewal payment. */
  @Prop()
  gracePeriodUntil?: Date;

  /** Number of failed renewal payment attempts in the current cycle. */
  @Prop({ default: 0 })
  failedPaymentAttempts: number;

  // ── Pause ───────────────────────────────────────────────────────────
  @Prop({ default: false })
  isPaused: boolean;

  @Prop()
  pausedAt?: Date;

  @Prop({ type: String })
  pauseReason?: string;

  /** Optional resume-on date for time-bounded pauses. */
  @Prop()
  resumeAt?: Date;

  // ── Entitlement override (live edits) ───────────────────────────────
  /**
   * Admin-set override applied on top of the plan's appliedEntitlements.
   * Sparse — only the fields admin actually changed are set. Empty / undefined
   * means "use the plan's entitlements as-is".
   */
  @Prop({ type: Object })
  entitlementsOverride?: Record<string, unknown>;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

// Product-scoped uniqueness: one active/trial subscription per (user, product),
// so a person can hold an active ERP sub AND an active Connect sub at once.
// MIGRATION NOTE (M0.8): the previously-deployed `{ userId }` and
// `{ userId, status }` unique indexes must be DROPPED on deploy, or the old
// userId-only uniqueness will still block a second product. Mongoose autoIndex
// adds the new indexes but does NOT drop the renamed old ones.
SubscriptionSchema.index(
  { userId: 1, product: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['active', 'trial'] } },
  },
);
SubscriptionSchema.index(
  { userId: 1, product: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'scheduled' } },
);
// One workspace-bound subscription per (user, workspace) at a time when
// active/trial. Account-level subscriptions (workspaceId=null) covered by the
// existing first index above.
SubscriptionSchema.index(
  { userId: 1, workspaceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['active', 'trial'] },
      workspaceId: { $type: 'objectId' },
    },
  },
);
