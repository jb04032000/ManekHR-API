import { describe, it, expect } from 'vitest';
import { ChronologicalStrategy } from '../chronological.strategy';
import type { FeedPost } from '../../feed.service';

describe('ChronologicalStrategy', () => {
  const strat = new ChronologicalStrategy();

  it('exposes the strategy key', () => {
    expect(strat.key).toBe('chrono');
  });

  it('returns the candidate window unchanged (already postedAt-sorted at read)', () => {
    // rank is identity — the FeedEntry query already sorted postedAt desc.
    const input = [{}, {}] as unknown as FeedPost[];
    expect(strat.rank(input)).toBe(input);
  });
});
