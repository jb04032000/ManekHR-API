import { describe, it, expect } from 'vitest';
import { nbvAtDisposalPaise } from '../disposal-nbv.util';

describe('nbvAtDisposalPaise', () => {
  // Disposal stores gainLoss = proceeds - nbv and then zeroes nbvPaise, so the
  // register must reconstruct NBV-at-disposal as proceeds - gainLoss.
  it('reconstructs NBV from proceeds and a gain (proceeds above NBV)', () => {
    // proceeds 50000, gain 20000 => NBV was 30000
    expect(nbvAtDisposalPaise(50000, 20000)).toBe(30000);
  });

  it('reconstructs NBV from proceeds and a loss (proceeds below NBV)', () => {
    // proceeds 50000, loss -10000 => NBV was 60000
    expect(nbvAtDisposalPaise(50000, -10000)).toBe(60000);
  });

  it('returns the proceeds when there was no gain or loss (sold at NBV)', () => {
    expect(nbvAtDisposalPaise(40000, 0)).toBe(40000);
  });

  it('handles a scrapped asset (zero proceeds, loss equals the lost NBV)', () => {
    // scrap: proceeds 0, loss -15000 => NBV was 15000
    expect(nbvAtDisposalPaise(0, -15000)).toBe(15000);
  });
});
