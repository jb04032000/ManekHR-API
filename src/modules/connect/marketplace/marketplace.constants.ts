/**
 * Marketplace shared constants — single source of truth.
 *
 * Cross-module links: imported by marketplace/services/listing.service.ts (the
 * create / status-transition path that counts slots) AND by
 * over-limit/connect-over-limit.service.ts (the "used" reconciler). Both MUST
 * agree on which statuses occupy a `maxListings` slot, so the constant lives
 * here once instead of being hand-mirrored in each service.
 *
 * Watch: changing this set changes what counts toward a seller's listing cap in
 * both the create gate and the over-limit reconciler at the same time — that is
 * the point. Do not re-inline a private copy in either consumer.
 */

/**
 * Listing lifecycle statuses that occupy a slot toward the `maxListings` cap.
 * Terminal states (`rejected`, `expired`) are excluded so a rejected listing
 * never permanently consumes the seller's allowance. A `draft` DOES occupy a
 * slot (drafts count), matching the create-path query in listing.service.ts.
 */
export const LISTING_SLOT_STATUSES = ['draft', 'pending_review', 'active', 'paused'] as const;
