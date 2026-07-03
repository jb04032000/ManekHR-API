import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- `ConnectPageInvite` (Institutes Phase 2, Feature 5: bulk
 * student invite + first-touch referral attribution).
 *
 * What this does: records ONE outbound student invite a page owner (an institute)
 * sent to a single mobile number. The page owner bulk-invites a list of student
 * phone numbers (ConnectPageInviteService.bulkInvite); each number that is not
 * already pending for that page gets one of these rows. Each row mints a random
 * shareable token (only its sha256 hash is persisted here, never the raw token);
 * the FE turns the raw token into a wa.me share link. When an invited mobile later
 * onboards into Connect, the first-touch attribution handler
 * (InstituteReferralService, on the `connect.profile.created` event) finds the
 * EARLIEST matching `invited` row by mobile, stamps `User.invitedByCompanyPageId`
 * (first-touch, never overwritten), and marks the winning row + its siblings
 * `claimed`.
 *
 * Cross-module links:
 *  - `companyPageId` -> Connect entities `CompanyPage` (the institute page that
 *    sent the invite; the page-owner gate is `CompanyPageService.getMine`).
 *  - `createdByUserId` -> `User` (the page owner who ran the bulk invite).
 *  - `claimedUserId`  -> `User` (the student whose Connect onboarding claimed this
 *    invite; `null` until claimed).
 *  - `inviteeMobile` is stored in the SAME canonical 12-digit `91XXXXXXXXXX` form
 *    that `User.mobile` is stored in (see auth `normaliseIndianMobile().full`), so
 *    the attribution match `inviteeMobile === user.mobile` is exact. Keep this in
 *    sync with the auth mobile-normalizer: if the canonical User.mobile form ever
 *    changes, this normalisation must change with it or attribution silently breaks.
 *
 * Keep in sync with:
 *  - ConnectPageInviteService (bulkInvite mints the token + writes these rows;
 *    summary counts `status: 'invited'` here for `pendingCount`).
 *  - InstituteReferralService (the `connect.profile.created` handler that claims
 *    the earliest matching row + its siblings).
 *  - `User.invitedByCompanyPageId` (the first-touch stamp this row drives).
 *
 * Additive only: brand-new collection, no legacy document to migrate; every
 * `@Prop` carries an explicit `{ type }` (required by the repo's Vitest SWC
 * transform so `SchemaFactory.createForClass` resolves under SWC).
 */

/** Lifecycle of a single page invite:
 *  - `invited` -- created, not yet claimed; counts toward `pendingCount`.
 *  - `claimed` -- an invited mobile onboarded into Connect and this row (or a
 *    sibling for the same mobile) won the first-touch claim.
 *  - `expired` -- past `inviteExpiry`; no longer eligible to claim (reserved for a
 *    future sweep; the attribution handler already ignores expired rows at read
 *    time, so a row may be logically expired before a sweep flips this flag). */
export const CONNECT_PAGE_INVITE_STATUSES = ['invited', 'claimed', 'expired'] as const;
export type ConnectPageInviteStatus = (typeof CONNECT_PAGE_INVITE_STATUSES)[number];

/** Invite link validity window. A claim past this is ignored (first-touch only
 *  considers non-expired `invited` rows). 30 days from creation. */
export const CONNECT_PAGE_INVITE_TTL_DAYS = 30;

@Schema({ timestamps: true, collection: 'connect_page_invites' })
export class ConnectPageInvite extends Document {
  /** The institute `CompanyPage` that sent this invite. */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', required: true })
  companyPageId: Types.ObjectId;

  /** The page owner `User` who ran the bulk invite. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdByUserId: Types.ObjectId;

  /** The invited mobile, normalised to canonical `91XXXXXXXXXX` (== User.mobile). */
  @Prop({ type: String, required: true, trim: true })
  inviteeMobile: string;

  /** sha256 hex of the random shareable token. Optional: the raw token is returned
   *  to the page owner ONCE (at create time) for the wa.me share link and is never
   *  stored; only this hash is persisted so a future link-claim path can verify a
   *  presented token without the DB ever holding the secret. */
  @Prop({ type: String, default: null })
  tokenHash?: string | null;

  /** When the invite link stops being claimable (createdAt + 30 days). */
  @Prop({ type: Date, required: true })
  inviteExpiry: Date;

  /** Invite lifecycle. Default `invited`. */
  @Prop({ type: String, enum: CONNECT_PAGE_INVITE_STATUSES, default: 'invited' })
  status: ConnectPageInviteStatus;

  /** The student `User` who claimed this invite (set by first-touch attribution). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  claimedUserId?: Types.ObjectId | null;

  /** When this invite was claimed (set alongside `claimedUserId`). */
  @Prop({ type: Date, default: null })
  claimedAt?: Date | null;

  // `createdAt` / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectPageInviteDocument = ConnectPageInvite & Document;

export const ConnectPageInviteSchema = SchemaFactory.createForClass(ConnectPageInvite);

// The page owner's per-page pending queue + the dedupe lookup ("does a non-expired
// `invited` row already exist for this page?"). Backs both bulkInvite's skip-existing
// check (which also filters `inviteExpiry > now`, so a logically-expired-but-unswept
// row does not block a re-invite) and summary's `pendingCount`.
ConnectPageInviteSchema.index({ companyPageId: 1, status: 1 });

// The attribution lookup by mobile: find the EARLIEST `invited` row for a mobile
// across institutes (first-touch wins) + mark siblings claimed. Sorted by
// createdAt at query time; this index narrows to the mobile + status first.
ConnectPageInviteSchema.index({ inviteeMobile: 1, status: 1 });
