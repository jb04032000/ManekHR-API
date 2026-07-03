/**
 * Domain events emitted by the Connect Profile module.
 *
 * `ConnectProfileService` fires {@link CONNECT_PROFILE_CHANGED} whenever a
 * `ConnectProfile` is created or its searchable content changes. Listeners
 * (currently the Connect `SearchService`, which keeps the Meilisearch
 * `connect_people` index warm) react asynchronously — the emit is
 * fire-and-forget, so a slow / failing listener never blocks the profile
 * write. Kept in its own file so a consumer can import the event name + its
 * payload type without pulling in `ConnectProfileService` (and its Mongoose
 * model graph), which would otherwise create a module cycle.
 */

/** Event name — a `ConnectProfile` was created or its content changed. */
export const CONNECT_PROFILE_CHANGED = 'connect.profile.changed';

/**
 * Payload for {@link CONNECT_PROFILE_CHANGED}. Carries only the `User` id —
 * a listener re-reads whatever current state it needs (e.g. the search
 * indexer re-fetches name / headline / skills / visibility), so the event
 * stays a thin, stable signal and never goes stale between emit and handling.
 */
export interface ConnectProfileChangedEvent {
  /** The `User` whose `ConnectProfile` changed (stringified ObjectId). */
  userId: string;
}
