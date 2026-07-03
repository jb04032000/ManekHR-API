/**
 * Domain events emitted by the Connect Entities module for company / institute
 * pages (SRCH-VERT-1).
 *
 * `CompanyPageService` fires {@link CONNECT_COMPANY_PAGE_CHANGED} on every
 * state-changing operation (create / edit / visibility-change / delete) — i.e.
 * whenever its searchability changes. The page-side mirror of
 * `connect.listing.changed`: a thin, fire-and-forget signal the search indexer
 * subscribes to with `@OnEvent` to keep the Meili `connect_pages` index warm
 * (only `public` pages are indexed; a `hidden` / `connections` / deleted page is
 * dropped). With no listener registered the emit is a clean no-op. Kept in its
 * own file so a consumer imports the name + type without pulling in
 * `CompanyPageService` (and its model graph), avoiding a cycle.
 */

/** Event name — a `CompanyPage` was created, edited, re-scoped, or deleted. */
export const CONNECT_COMPANY_PAGE_CHANGED = 'connect.companyPage.changed';

/**
 * Payload for {@link CONNECT_COMPANY_PAGE_CHANGED}. Carries only the page id; the
 * listener re-reads the latest state (visibility, name, kind, etc.), so the event
 * stays a thin, stable signal. When the listener fetches the page back and finds
 * it deleted / non-public, that is the cue to remove the doc from the index.
 */
export interface ConnectCompanyPageChangedEvent {
  /** The `CompanyPage._id` whose state changed (stringified ObjectId). */
  companyPageId: string;
}
