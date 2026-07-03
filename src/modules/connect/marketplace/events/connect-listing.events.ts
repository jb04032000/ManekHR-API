/**
 * Domain events emitted by the Connect Marketplace module (M1.4).
 *
 * `ListingService` + `ListingModerationService` fire
 * {@link CONNECT_LISTING_CHANGED} on every state-changing operation: create,
 * owner edit, publish, pause, owner delete, admin approve, admin reject. The
 * Connect `SearchService` listens and re-indexes (or de-indexes) the listing
 * in the `connect_listings` Meili index, so the public marketplace search
 * stays warm with no manual reindex step.
 *
 * Fire-and-forget: the emit is async, so a slow / failing listener never
 * blocks the listing write. The payload is a thin signal (just the listing
 * id) - the listener re-reads the latest listing state, so the event never
 * goes stale between emit and handling.
 *
 * Kept in its own file so a consumer can import the event name + its payload
 * type without pulling in `ListingService` (and its Mongoose model graph),
 * which would otherwise create a module cycle between the marketplace + search
 * modules.
 */

/** Event name - a `Listing` was created, edited, moderated, or deleted. */
export const CONNECT_LISTING_CHANGED = 'connect.listing.changed';

/**
 * Payload for {@link CONNECT_LISTING_CHANGED}. Carries only the listing id;
 * the listener re-reads whatever current state it needs (status,
 * moderationStatus, title, etc.), so the event stays a thin, stable signal.
 *
 * When the listener fetches the listing back and finds it deleted, that is
 * the cue to remove the doc from the index (the owner-`remove` path emits
 * the event and then deletes; the de-index call is the listener's job).
 */
export interface ConnectListingChangedEvent {
  /** The `Listing._id` whose state changed (stringified ObjectId). */
  listingId: string;
}
