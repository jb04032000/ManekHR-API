import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Shape of a per-scope DPDP deletion marker (ACCOUNT-DELETION-AND-DPDP-PLAN.md
 * §4). `requestedBy` is the user (self-serve schedule) or admin that triggered
 * it; `purgeAfter = requestedAt + DELETION_GRACE_DAYS`.
 */
export interface AccountDeletionMarker {
  state: 'pending' | 'purged';
  requestedAt: Date;
  purgeAfter: Date;
  requestedBy: Types.ObjectId;
  /**
   * When the ~Day-25 "recovery window closing" reminder was sent (Phase 2,
   * §3C/§7). Dedup anchor so the reminder cron emails at most once per pending
   * deletion. Optional + additive — unset on legacy rows and until the first
   * reminder fires.
   */
  reminderSentAt?: Date;
}

// Embedded sub-document definition reused by all three deletion-marker fields.
// `_id:false` keeps it a plain nested object (no surrogate id). Plain literal so
// the three @Prop() declarations share one definition without divergence.
const AccountDeletionMarkerSchemaDef = {
  state: { type: String, enum: ['pending', 'purged'], required: true },
  requestedAt: { type: Date, required: true },
  purgeAfter: { type: Date, required: true },
  requestedBy: { type: Types.ObjectId, ref: 'User', required: true },
  // Phase 2 reminder dedup (optional; set by the Day-25 reminder cron).
  reminderSentAt: { type: Date, required: false },
} as const;

@Schema({ timestamps: true })
export class User extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ unique: true, sparse: true })
  email?: string;

  @Prop({ unique: true, sparse: true })
  mobile?: string;

  @Prop({ select: false })
  passwordHash?: string;

  // ── Email forgot-password — bcrypt-hashed reset token + expiry ──────────
  // Set by /auth/forgot-password (when email path resolves to a known user)
  // and consumed by /auth/reset-password. The raw token is sent to the user
  // by email; only the bcrypt hash is persisted here so a database leak
  // doesn't grant attackers the ability to reset arbitrary passwords. The
  // hash + expiry are cleared on successful reset (single-use semantics).
  @Prop({ select: false })
  resetPasswordTokenHash?: string;

  @Prop({ type: Date, default: null, select: false })
  resetPasswordExpiresAt?: Date | null;

  @Prop()
  googleId?: string;

  @Prop({ default: false })
  isEmailVerified: boolean;

  @Prop({ select: false })
  emailVerificationToken?: string;

  @Prop({ select: false })
  pinHash?: string;

  @Prop({ type: Date })
  pinSetAt?: Date;

  @Prop({ type: Number, default: 0, select: false })
  pinAttempts: number;

  @Prop({ type: Date, default: null, select: false })
  pinLockedUntil?: Date | null;

  /**
   * App Lock — per-user idle timeout in milliseconds. After this many ms of
   * inactivity the App Lock kicks in and the user must re-enter their PIN.
   * `null` (default) ⇒ fall through to the per-workspace `Workspace.appLockIdleMs`,
   * then to the deployment-wide `APP_LOCK_IDLE_MS` env default. Setting this on
   * a User is the personal override that wins over the workspace value — it
   * is also the ONLY idle source for a Connect-only (workspace-less) account.
   */
  @Prop({ type: Number, default: null })
  appLockIdleMs?: number | null;

  @Prop({ default: false })
  isMobileVerified: boolean;

  // ── SMS-OTP (auth) — mirror email-verification + PIN lockout patterns ───
  // mobileVerificationToken is a signed JWT carrying the OTP + flow type, not
  // the raw 6-digit code. JWT expiry is the source of truth for OTP TTL.
  @Prop({ select: false })
  mobileVerificationToken?: string;

  @Prop({ type: Date, select: false })
  mobileVerificationExpiresAt?: Date;

  @Prop({ type: Number, default: 0, select: false })
  mobileOtpAttempts: number;

  @Prop({ type: Date, default: null, select: false })
  mobileOtpLockedUntil?: Date | null;

  @Prop({ type: Date, select: false })
  mobileOtpLastSentAt?: Date;

  @Prop({ type: String, default: null, select: false })
  mobileVerificationFlow?: 'login' | 'register' | 'forgot' | 'verify' | 'stepup' | null;

  @Prop({ default: false })
  hasWorkspace: boolean;

  /**
   * Public profile slug — the human-readable identifier in `/u/<handle>`.
   * Lowercase 3–30 chars `[a-z0-9-]`. Auto-generated at signup from `name`
   * (collision-suffix loop); user-editable from `/account/profile` with a
   * 30-day cooldown. `null` for pre-backfill rows / placeholder users — the
   * `/u/[slug]` resolver falls back to ObjectId lookup in that case.
   *
   * Unique case-insensitively via the schema-level index below (collation
   * strength 2). Stored exclusively lowercase.
   */
  @Prop({ type: String, default: null })
  handle?: string | null;

  /**
   * When `handle` was last claimed by this user. Drives the 30-day cooldown
   * on user-initiated changes. `null` for auto-generated handles — the
   * cooldown applies only after the first manual claim.
   */
  @Prop({ type: Date, default: null })
  handleChangedAt?: Date | null;

  @Prop()
  profilePicture?: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isAdmin: boolean;

  /**
   * ManekHR Connect — per-user access flag. Connect is the default front door,
   * so this defaults to `true` for every account. Retained only as an admin
   * kill-switch: setting it `false` makes the user see the Connect "coming
   * soon" placeholder instead of the app. See
   * docs/connect/specs/2026-05-19-connect-first-architecture-design.md §10.
   */
  @Prop({ type: Boolean, default: true })
  connectEnabled: boolean;

  /**
   * ManekHR Connect — timestamp the user accepted the Connect policy/terms.
   * Null/absent ⇒ not yet accepted; the Connect entry shows the consent gate.
   * (A full policy module — versioned, admin-managed content — is separate.)
   */
  @Prop({ type: Date, default: null })
  connectPolicyAcceptedAt?: Date | null;

  /**
   * ManekHR Connect — marks a seeded demo / sample account
   * (see `scripts/seed-connect.ts`). Lets the admin demo-manager list and
   * bulk-remove launch demo content, while real accounts (`isDemo=false`) stay
   * untouched. Defaults false, so every existing and real user is unaffected.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  /**
   * ManekHR ERP — timestamp the user accepted the ERP policy/terms.
   * Null/absent ⇒ not yet accepted; the ERP shell shows the consent gate.
   * Mirrors `connectPolicyAcceptedAt`; the future admin-synced policy module
   * consolidates both into one versioned record.
   */
  @Prop({ type: Date, default: null })
  erpPolicyAcceptedAt?: Date | null;

  /**
   * UI hints / nudges the user has permanently dismissed (e.g. the Connect
   * explore nudge). Persisted here — not in localStorage — so a dismissal
   * survives sign-out and follows the user across devices.
   */
  @Prop({ type: [String], default: [] })
  dismissedHints: string[];

  @Prop()
  deletedAt?: Date;

  @Prop()
  deactivationNote?: string;

  @Prop()
  deactivatedAt?: Date;

  /**
   * DPDP self-serve deletion markers (ACCOUNT-DELETION-AND-DPDP-PLAN.md §4).
   * Additive — every field defaults `undefined`, so legacy rows and the
   * common (not-deleting) case are byte-identical to before; no migration.
   *
   * `state==='pending'` is the 30-day recovery timer anchor. While pending,
   * the row is SUSPENDED (`isActive=false`) but NOT finalized: `email`/`mobile`
   * stay populated (blocks re-signup during grace) and `deletedAt` stays unset
   * (retention crons key on `deletedAt`/`isDeleted`, never on `isActive`, so a
   * suspended-pending account is never mistaken for a scrubbed one). The
   * Day-30 finalize (`eraseAccount`) flips the state to `'purged'` and sets
   * `deletedAt`. Recovery is admin-mediated (no self-cancel) — an admin clears
   * the marker + `isActive=true` within the window.
   *
   *   - `connectDeletion` — Scope 1 (delete Connect only; account NOT suspended).
   *   - `erpDeletion`     — Scope 2 (delete ERP only; account NOT suspended).
   *   - `accountDeletion` — Scope 3 (delete whole profile; account SUSPENDED).
   */
  @Prop({ type: AccountDeletionMarkerSchemaDef, default: undefined, _id: false })
  connectDeletion?: AccountDeletionMarker;

  @Prop({ type: AccountDeletionMarkerSchemaDef, default: undefined, _id: false })
  erpDeletion?: AccountDeletionMarker;

  @Prop({ type: AccountDeletionMarkerSchemaDef, default: undefined, _id: false })
  accountDeletion?: AccountDeletionMarker;

  /**
   * ManekHR Connect (Institutes Phase 2, Feature 5): first-touch referral
   * source. When this user first onboards into Connect (their ConnectProfile is
   * lazily created), the institutes referral handler stamps this with the
   * `CompanyPage` of the FIRST institute that invited their mobile (see
   * InstituteReferralService). First-touch only: once set it is NEVER overwritten,
   * so a later institute's invite cannot steal an already-credited student. Drives
   * the institute admin's "joined" count (`summary.joinedCount`). Additive,
   * defaults `null` (legacy rows + organically-joined users need no migration and
   * stay unattributed). This is the ONLY edit outside the Connect modules; the raw
   * auth / registration / OTP path is intentionally untouched (attribution runs on
   * first Connect onboarding, decoupled via the `connect.profile.created` event).
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  invitedByCompanyPageId?: Types.ObjectId | null;

  /** The user's own shareable referral code. Set lazily on first share/visit.
   *  Cross-module: ConnectReferral.codeUsed resolves back to this user. */
  @Prop({ type: String, index: { unique: true, sparse: true } })
  referralCode?: string;

  /** Who referred this user. Set ONCE at signup, immutable (first-code-wins).
   *  Mirrors invitedByCompanyPageId. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  referredByUserId?: Types.ObjectId | null;

  @Prop({ type: Number, default: null })
  sessionLimitOverride?: number | null;

  @Prop({ type: [String], default: [] })
  accountantWorkspaces: string[];

  @Prop({ type: String })
  fcmToken?: string;

  @Prop({ type: Date })
  fcmTokenUpdatedAt?: Date;

  /**
   * Razorpay Customer id (D1c). One Razorpay Customer per local User,
   * cached here on first mandate creation. Sparse — only set for users
   * who have started a recurring auto-renew flow. Stale-recovery: if a
   * `subscriptions.create` call fails with "customer not found" (admin
   * deleted it in dashboard), this is nulled and re-created via
   * `customers.create({fail_existing:0})`.
   */
  @Prop({ type: String, sparse: true })
  razorpayCustomerId?: string;

  /**
   * Billing profile (D1f) — populates the recipient block on GST B2B
   * invoices. Snapshot of these fields is captured onto every
   * `SubscriptionPayment.billingSnapshot` at order-create time so the
   * invoice is reproducible from the payment row alone (User edits
   * after the fact don't retroactively change historical invoices).
   *
   * `gstin` triggers a B2B-style invoice (recipient state derived from
   * GSTIN's first 2 chars takes precedence). Without `gstin`, a B2C
   * invoice is rendered using `address.stateCode` for place-of-supply.
   *
   * `stateCode` is the 2-digit GST state code per the Place of Supply
   * rules (e.g. 27 = Maharashtra, 24 = Gujarat). Must match GSTIN's
   * first 2 chars when both are set.
   */
  @Prop({
    type: {
      gstin: { type: String, required: false },
      businessName: { type: String, required: false },
      addressLine1: { type: String, required: false },
      addressLine2: { type: String, required: false },
      city: { type: String, required: false },
      state: { type: String, required: false },
      stateCode: { type: String, required: false },
      pincode: { type: String, required: false },
      country: { type: String, required: false, default: 'India' },
    },
    required: false,
    _id: false,
  })
  billingProfile?: {
    gstin?: string;
    businessName?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    stateCode?: string;
    pincode?: string;
    country?: string;
  };
}

export const UserSchema = SchemaFactory.createForClass(User);

// Case-insensitive uniqueness on `handle` — collation strength 2 treats
// upper / lower case as equal at the index level. Sparse so users without
// a handle (pre-backfill / placeholder) do NOT collide on the implicit
// `null` value. Storage convention is always lowercase; this index is the
// safety net against any drift.
UserSchema.index(
  { handle: 1 },
  { unique: true, sparse: true, collation: { locale: 'en', strength: 2 } },
);

// First-touch referral attribution (Institutes Phase 2, Feature 5). The institute
// summary endpoint counts User.countDocuments({ invitedByCompanyPageId: pageId }),
// so without an index that is a full collection scan over every product user.
// Sparse: the field is null for nearly all users (only invited-and-onboarded
// students carry it), so the index stays tiny and the count becomes an index scan.
// Additive, no migration. Keep in sync with the institutes ConnectPageInviteService
// summary() + InstituteReferralService stamp.
UserSchema.index({ invitedByCompanyPageId: 1 }, { sparse: true });

// Google sign-in lookup (launch perf — Workstream F). AuthService.googleAuth
// resolves the account via findByGoogleId -> findOne({ googleId }). Without an
// index that is a full collection scan over EVERY user on a pre-auth hot path.
// Sparse: googleId is absent on mobile/email/password users, so the index stays
// small and only the (minority) Google-linked accounts are indexed. Non-unique
// by deliberate choice — a unique constraint would be the stronger integrity
// guard (one Google account = one user) but risks a failed index build if any
// duplicate googleId already exists in prod; the perf goal (kill the COLLSCAN)
// is fully met by this plain sparse index. Upgrading to unique+sparse is a safe
// hardening once the data is confirmed dup-free. Additive, no migration.
UserSchema.index({ googleId: 1 }, { sparse: true });
