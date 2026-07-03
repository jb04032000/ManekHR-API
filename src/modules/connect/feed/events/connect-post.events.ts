/**
 * Domain events emitted by the Connect Feed module.
 *
 * `FeedService` fires {@link CONNECT_POST_CHANGED} whenever a post is created,
 * edited, or soft-deleted - i.e. whenever its searchable content changes. It is
 * the post-side mirror of `connect.profile.changed`: a thin, fire-and-forget
 * signal a future post-search indexer (Wave 5 - posts-in-search) subscribes to
 * with `@OnEvent` to keep a Meilisearch `connect_posts` index warm. With no
 * listener registered yet the emit is a clean no-op, so it is safe to ship the
 * emit ahead of the indexer (the same decoupling the profile event uses). Kept
 * in its own file so a consumer can import the event name + payload type without
 * pulling in `FeedService` (and its Mongoose model graph), avoiding a cycle.
 */

/** Event name - a post was created, edited, or deleted (content changed). */
export const CONNECT_POST_CHANGED = 'connect.post.changed';

/** How the post changed - lets a listener delete vs upsert its index entry. */
export type ConnectPostChangeType = 'created' | 'updated' | 'deleted';

/**
 * Payload for {@link CONNECT_POST_CHANGED}. Carries the post id + the kind of
 * change. A listener re-reads whatever current state it needs (so the event
 * stays a thin, stable signal that never goes stale between emit and handling);
 * `change: 'deleted'` lets it drop the index entry without a re-read.
 */
export interface ConnectPostChangedEvent {
  /** The post that changed (stringified ObjectId). */
  postId: string;
  /** What happened to it. */
  change: ConnectPostChangeType;
}
