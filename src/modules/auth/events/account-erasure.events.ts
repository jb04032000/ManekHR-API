/**
 * Domain events emitted by the Auth account-erasure flow.
 *
 * `AccountErasureService` fires {@link ACCOUNT_ERASED} after it scrubs a user's
 * Bucket-C identity (anonymize-don't-delete). Downstream modules listen to
 * react WITHOUT auth taking a dependency on them (no module cycle): e.g. the
 * Connect profile module hides the now-erased user from public Connect surfaces
 * and de-indexes them from search (auth-hardening OQ-3). Fire-and-forget; a
 * slow / failing listener never blocks the erasure write.
 */

/** Event name -- a user account was erased (admin-triggered, anonymize). */
export const ACCOUNT_ERASED = 'auth.account.erased';

/**
 * Payload for {@link ACCOUNT_ERASED}. Carries only the erased `User` id; a
 * listener re-reads whatever current state it needs so the event stays a thin,
 * stable signal.
 */
export interface AccountErasedEvent {
  /** The erased `User` (stringified ObjectId). */
  userId: string;
}
