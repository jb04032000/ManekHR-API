import { describe, it, expect } from 'vitest';
import { isBannerLive } from '../banner-live-window';

const NOW = new Date('2026-07-03T12:00:00.000Z');
const past = (mins: number) => new Date(NOW.getTime() - mins * 60_000);
const future = (mins: number) => new Date(NOW.getTime() + mins * 60_000);

describe('isBannerLive', () => {
  it('is live when active with no window bounds (both null)', () => {
    expect(isBannerLive({ isActive: true, liveFrom: null, liveUntil: null }, NOW)).toBe(true);
  });

  it('is live when active with no window bounds (both undefined)', () => {
    expect(isBannerLive({ isActive: true }, NOW)).toBe(true);
  });

  it('is NOT live when inactive, even inside the window', () => {
    expect(isBannerLive({ isActive: false, liveFrom: past(60), liveUntil: future(60) }, NOW)).toBe(
      false,
    );
  });

  it('is NOT live before the window starts (liveFrom in the future)', () => {
    expect(isBannerLive({ isActive: true, liveFrom: future(1) }, NOW)).toBe(false);
  });

  it('is NOT live after the window ends (liveUntil in the past)', () => {
    expect(isBannerLive({ isActive: true, liveUntil: past(1) }, NOW)).toBe(false);
  });

  it('is live inside the window', () => {
    expect(isBannerLive({ isActive: true, liveFrom: past(60), liveUntil: future(60) }, NOW)).toBe(
      true,
    );
  });

  it('is live at the exact liveFrom boundary (inclusive start)', () => {
    expect(isBannerLive({ isActive: true, liveFrom: new Date(NOW) }, NOW)).toBe(true);
  });

  it('is live at the exact liveUntil boundary (inclusive end)', () => {
    expect(isBannerLive({ isActive: true, liveUntil: new Date(NOW) }, NOW)).toBe(true);
  });

  it('is live with only a start bound in the past and no end', () => {
    expect(isBannerLive({ isActive: true, liveFrom: past(1) }, NOW)).toBe(true);
  });
});
