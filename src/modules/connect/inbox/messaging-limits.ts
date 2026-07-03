/**
 * ManekHR Connect -- Inbox (Phase 7, I5) open-DM rate-limit tiers.
 *
 * Pure tier resolution + the per-tier token-bucket caps, separated from the
 * Redis-backed limiter so the (numeric, policy) decisions unit-test without a
 * client. The caps bite on COLD new-thread INITIATION only -- replies into an
 * existing thread and acting-on-the-platform context threads (inquiry /
 * application / quote = consent to be contacted) are never limited here.
 *
 * Numbers are tunable: they cap how many brand-new strangers a person can cold-
 * message, scaled by trust. A token bucket gives a small burst (capacity) plus a
 * slow sustained refill, so a legitimate user is never hard-stopped for a day.
 */

export type MessagingTier = 'new' | 'established' | 'verified';

/** An account younger than this is treated as `new` (unless verified). */
export const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenBucketCap {
  /** Burst size: how many cold initiations are allowed back-to-back. */
  capacity: number;
  /** Sustained refill, tokens per second (derived from a per-day budget). */
  refillPerSec: number;
  /** Key TTL so an idle bucket is reclaimed (it refills to full anyway). */
  ttlSec: number;
}

const PER_DAY = 24 * 60 * 60;
const BUCKET_TTL_SEC = 2 * PER_DAY;

/**
 * Per-tier cold-initiation caps. Verified (GST / ERP-linked badge) > Established
 * (account >= 7d) > New (< 7d). Tunable.
 */
export const MESSAGING_INITIATION_CAPS: Record<MessagingTier, TokenBucketCap> = {
  new: { capacity: 5, refillPerSec: 10 / PER_DAY, ttlSec: BUCKET_TTL_SEC },
  established: { capacity: 20, refillPerSec: 40 / PER_DAY, ttlSec: BUCKET_TTL_SEC },
  verified: { capacity: 50, refillPerSec: 100 / PER_DAY, ttlSec: BUCKET_TTL_SEC },
};

/**
 * Resolve a sender's messaging tier. Verification wins over age; an unknown
 * `createdAt` is treated as the most-restrictive `new`. Pure + `now`-injectable.
 */
export function resolveMessagingTier(input: {
  createdAt: Date | string | null | undefined;
  verified: boolean;
  now: Date;
}): MessagingTier {
  if (input.verified) return 'verified';
  if (!input.createdAt) return 'new';
  const created = new Date(input.createdAt).getTime();
  if (!Number.isFinite(created)) return 'new';
  const ageMs = input.now.getTime() - created;
  return ageMs >= NEW_ACCOUNT_MS ? 'established' : 'new';
}
