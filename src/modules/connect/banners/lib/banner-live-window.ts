/**
 * Pure live-window predicate for Connect feed banners.
 *
 * A banner is "live" (publicly servable) when it is active AND the current
 * instant falls inside its optional [liveFrom, liveUntil] window. Both bounds
 * are OPTIONAL: a null/absent `liveFrom` means "live since forever" and a
 * null/absent `liveUntil` means "live until forever". Boundaries are INCLUSIVE
 * on both ends (now === liveFrom or now === liveUntil counts as live).
 *
 * Kept pure (no Mongo, no Date.now()) so the window semantics — the part most
 * prone to off-by-one / null-bound bugs — are exhaustively unit tested in
 * isolation. The service does the cheap `{ isActive: true }` + sort in Mongo
 * and applies THIS predicate in memory over the small, admin-curated banner
 * set. Cross-links: banner.service.ts (listActive),
 * __tests__/banner-live-window.vitest.ts (tests).
 */
export interface BannerLiveWindow {
  isActive: boolean;
  liveFrom?: Date | null;
  liveUntil?: Date | null;
}

export function isBannerLive(banner: BannerLiveWindow, now: Date): boolean {
  if (!banner.isActive) return false;
  const t = now.getTime();
  if (banner.liveFrom && banner.liveFrom.getTime() > t) return false;
  if (banner.liveUntil && banner.liveUntil.getTime() < t) return false;
  return true;
}
