/**
 * Domain events emitted by the Connect Entities module for storefronts
 * (SRCH-VERT-1).
 *
 * `StorefrontService` fires {@link CONNECT_STOREFRONT_CHANGED} on every
 * state-changing operation (create / edit / visibility-change / delete) — i.e.
 * whenever its searchability changes. The storefront-side mirror of
 * `connect.listing.changed`: a thin, fire-and-forget signal the search indexer
 * subscribes to with `@OnEvent` to keep the Meili `connect_storefronts` index
 * warm (only `public` storefronts are indexed; a `hidden` / `connections` /
 * deleted shop is dropped). With no listener registered the emit is a clean
 * no-op. Kept in its own file so a consumer imports the name + type without
 * pulling in `StorefrontService` (and its model graph), avoiding a cycle.
 */

/** Event name — a `Storefront` was created, edited, re-scoped, or deleted. */
export const CONNECT_STOREFRONT_CHANGED = 'connect.storefront.changed';

/**
 * Payload for {@link CONNECT_STOREFRONT_CHANGED}. Carries only the storefront id;
 * the listener re-reads the latest state (visibility, name, etc.), so the event
 * stays a thin, stable signal that never goes stale between emit and handling.
 * When the listener fetches the shop back and finds it deleted / non-public, that
 * is the cue to remove the doc from the index.
 */
export interface ConnectStorefrontChangedEvent {
  /** The `Storefront._id` whose state changed (stringified ObjectId). */
  storefrontId: string;
}
