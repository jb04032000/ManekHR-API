/**
 * Domain event emitted when a brand-new `ConnectProfile` is lazily created
 * (Institutes Phase 2, Feature 5: first-touch referral attribution).
 *
 * `ConnectProfileService.getOrCreateForUser` fires {@link CONNECT_PROFILE_CREATED}
 * exactly once per user, on the FIRST Connect onboarding (the create branch), not
 * on a cache hit and not at raw auth/registration. By design, referral attribution
 * happens here (decoupled) so the core auth / registration / OTP path stays
 * untouched: a listener reacts asynchronously to credit the first institute that
 * invited this user's mobile.
 *
 * Distinct from `CONNECT_PROFILE_CHANGED` (`connect.profile.changed`), which also
 * fires on content edits and drives the search indexer. This one is a strict
 * "profile FIRST created" signal so the attribution handler runs once and only
 * once. Kept in its own file so a consumer (InstituteReferralService) can import
 * the event name + payload type WITHOUT pulling in `ConnectProfileService` (and
 * its Mongoose model graph), which would otherwise create a module cycle.
 *
 * Keep in sync with: ConnectProfileService.getOrCreateForUser (the single emit
 * site) and InstituteReferralService.@OnEvent(CONNECT_PROFILE_CREATED).
 */

/** Event name: a `ConnectProfile` was created for the first time. */
export const CONNECT_PROFILE_CREATED = 'connect.profile.created';

/**
 * Payload for {@link CONNECT_PROFILE_CREATED}. Carries only the `User` id, the
 * handler re-reads whatever current state it needs (e.g. the user's mobile),
 * keeping the event a thin, stable signal that never goes stale between emit and
 * handling.
 */
export interface ConnectProfileCreatedEvent {
  /** The `User` whose `ConnectProfile` was just created (stringified ObjectId). */
  userId: string;
}
