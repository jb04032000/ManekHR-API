import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import {
  ConnectPageInvite,
  type ConnectPageInviteDocument,
} from './schemas/connect-page-invite.schema';
import { User } from '../../users/schemas/user.schema';
import {
  CONNECT_PROFILE_CREATED,
  type ConnectProfileCreatedEvent,
} from '../profile/events/connect-profile-created.events';

/**
 * ManekHR Connect -- `InstituteReferralService` (Institutes Phase 2, Feature 5:
 * first-touch referral attribution).
 *
 * What this does: when a user first onboards into Connect (their ConnectProfile is
 * lazily created -> `connect.profile.created` fires), this handler credits the
 * FIRST institute that invited that user's mobile. It loads the user's mobile,
 * finds the EARLIEST-created `invited`, non-expired `ConnectPageInvite` for that
 * mobile across all institutes (first-touch), and, only if the user is not already
 * attributed, stamps `User.invitedByCompanyPageId` with that invite's page and
 * marks the winning invite plus any sibling `invited` rows for the same mobile
 * `claimed` (so a later onboarding can never re-claim them).
 *
 * Design notes (intentional, do not "fix"):
 *  - Attribution happens on FIRST CONNECT ONBOARDING, NOT at raw auth/registration.
 *    The core auth path is intentionally untouched (the ONLY non-Connect edit is
 *    the additive `User.invitedByCompanyPageId` field). This handler reacts to a
 *    Connect-internal event, so all referral logic stays inside Connect.
 *  - FIRST-TOUCH ONLY: the credit is set once and NEVER overwritten. If
 *    `user.invitedByCompanyPageId` is already set, this is a no-op (a second
 *    `profile.created` for an already-stamped user changes nothing).
 *  - EARLIEST INVITE WINS: when two institutes invited the same mobile, the one
 *    that invited FIRST (earliest `createdAt`) gets the credit.
 *  - Fully defensive: the whole body is wrapped; a fault is logged + captured for
 *    Sentry but NEVER thrown out of the handler (EventEmitter2 emits synchronously,
 *    so an escape would surface inside the profile create that fired the event).
 *
 * Cross-module links:
 *  - listens to `CONNECT_PROFILE_CREATED` (profile module event; imported by name
 *    + type only, so no static dep on ConnectProfileService = no module cycle).
 *  - `User` -> the mobile lookup + the first-touch stamp (`invitedByCompanyPageId`).
 *    The User model token is registered schema-only on this module's `forFeature`.
 *  - `ConnectPageInvite` (this module) -> the earliest-invite lookup + the claim.
 *
 * Keep in sync with: ConnectProfileService.getOrCreateForUser (the emit site),
 * the ConnectPageInvite schema (status enum), and `User.invitedByCompanyPageId`.
 */
@Injectable()
export class InstituteReferralService {
  private readonly logger = new Logger(InstituteReferralService.name);

  constructor(
    @InjectModel(ConnectPageInvite.name)
    private readonly inviteModel: Model<ConnectPageInviteDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  /**
   * First-touch referral attribution on first Connect onboarding. See the class
   * doc-comment for the full contract. Never throws.
   */
  @OnEvent(CONNECT_PROFILE_CREATED)
  async onProfileCreated(ev: ConnectProfileCreatedEvent): Promise<void> {
    try {
      if (!ev?.userId || !Types.ObjectId.isValid(ev.userId)) return;

      // Load the freshly-onboarded user: their mobile (the invite match key) +
      // whether they are already attributed (first-touch guard). Select mobile
      // explicitly since it may be excluded by a default projection elsewhere; it
      // is NOT `select:false` on the schema, so a plain select is enough here.
      const user = await this.userModel
        .findById(ev.userId)
        .select('mobile invitedByCompanyPageId')
        .lean<{
          _id: Types.ObjectId;
          mobile?: string | null;
          invitedByCompanyPageId?: Types.ObjectId | null;
        } | null>()
        .exec();

      // No user, no mobile, or ALREADY attributed -> nothing to do. The
      // already-attributed check is the first-touch guard: a second
      // `profile.created` (or a re-onboard) must NEVER overwrite the credit.
      if (!user || !user.mobile || user.invitedByCompanyPageId != null) return;

      // Find the EARLIEST `invited`, non-expired invite for this mobile across all
      // institutes -> first-touch winner. `inviteExpiry > now` ignores stale links
      // even if a sweep has not yet flipped them to `expired`.
      const winner = await this.inviteModel
        .findOne({
          inviteeMobile: user.mobile,
          status: 'invited',
          inviteExpiry: { $gt: new Date() },
        })
        .sort({ createdAt: 1 })
        .select('_id companyPageId')
        .lean<{ _id: Types.ObjectId; companyPageId: Types.ObjectId } | null>()
        .exec();

      if (!winner) return; // The user's mobile was never invited -> unattributed.

      // Stamp first-touch, but ONLY if still unset (guards a race where two
      // `profile.created` events overlap: the conditional update is the atomic
      // gate). If another concurrent run already stamped it, `modifiedCount` is 0
      // and we do not claim invites for a credit we did not set.
      const stamp = await this.userModel
        .updateOne(
          { _id: user._id, invitedByCompanyPageId: null },
          { $set: { invitedByCompanyPageId: winner.companyPageId } },
        )
        .exec();
      if ((stamp.modifiedCount ?? 0) === 0) return;

      // Mark the winning invite AND any sibling `invited` rows for the same mobile
      // (across institutes) as claimed, so a later onboarding cannot re-claim them
      // and the losers' pending counts settle. Best-effort: a claim-update fault
      // does not undo the (already-committed) first-touch stamp.
      await this.inviteModel
        .updateMany(
          { inviteeMobile: user.mobile, status: 'invited' },
          { $set: { status: 'claimed', claimedUserId: user._id, claimedAt: new Date() } },
        )
        .exec();
    } catch (err) {
      // Never throw out of the handler (EventEmitter2 emits synchronously inside
      // the profile create). Log + capture for observability only.
      this.logger.warn(
        `referral attribution failed for user ${ev?.userId ?? '<unknown>'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.institute_referral', op: 'onProfileCreated' },
      });
    }
  }
}
