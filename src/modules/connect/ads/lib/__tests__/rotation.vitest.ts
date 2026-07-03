import { describe, it, expect } from 'vitest';
import { pickTopWithRotation, EQUAL_BID_EPSILON } from '../rotation';

describe('pickTopWithRotation', () => {
  it('returns the sole top candidate when nothing is within epsilon', () => {
    const scored = [
      { c: 'a', s: 10 },
      { c: 'b', s: 5 },
    ];
    expect(pickTopWithRotation(scored, () => 0.99)).toBe('a');
  });

  it('rotates among effective ties using the rng', () => {
    const scored = [
      { c: 'a', s: 10 },
      { c: 'b', s: 10 },
      { c: 'c', s: 10 },
    ];
    // rng buckets: [0,1/3)->a, [1/3,2/3)->b, [2/3,1)->c
    expect(pickTopWithRotation(scored, () => 0.0)).toBe('a');
    expect(pickTopWithRotation(scored, () => 0.5)).toBe('b');
    expect(pickTopWithRotation(scored, () => 0.9)).toBe('c');
  });

  it('treats scores within epsilon as tied, excludes those beyond it', () => {
    const scored = [
      { c: 'a', s: 10 },
      { c: 'b', s: 10 - EQUAL_BID_EPSILON / 2 }, // tied
      { c: 'c', s: 10 - EQUAL_BID_EPSILON * 2 }, // not tied
    ];
    // tie group is {a,b}; rng 0.9 -> floor(0.9*2)=1 -> b
    expect(pickTopWithRotation(scored, () => 0.9)).toBe('b');
    // never picks c
    expect(pickTopWithRotation(scored, () => 0.999)).toBe('b');
  });

  it('guards rng() === 1 (never indexes past the tie group)', () => {
    const scored = [
      { c: 'a', s: 10 },
      { c: 'b', s: 10 },
    ];
    expect(pickTopWithRotation(scored, () => 1)).toBe('b');
  });

  it('statistically shares wins between two equal bidders over many runs', () => {
    const scored = [
      { c: 'a', s: 10 },
      { c: 'b', s: 10 },
    ];
    let aWins = 0;
    let bWins = 0;
    for (let i = 0; i < 2000; i++) {
      const w = pickTopWithRotation(scored); // real Math.random
      if (w === 'a') aWins++;
      else bWins++;
    }
    // Both must win a meaningful share (not starved). ~50/50 expected; allow wide band.
    expect(aWins).toBeGreaterThan(700);
    expect(bWins).toBeGreaterThan(700);
  });
});
