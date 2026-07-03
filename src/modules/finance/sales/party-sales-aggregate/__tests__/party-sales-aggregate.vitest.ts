import { describe, it, expect } from 'vitest';
import { PartySalesAggregateService } from '../party-sales-aggregate.service';

// computeTcs is a pure method; the Mongoose model is unused by it, so a bare
// instance with a stub model is enough to exercise the logic.
const svc = new PartySalesAggregateService({} as any);

const CR_12_AATO = 120; // aato is in lakhs; 120 = Rs 12 Cr (> Rs 10 Cr trigger)
const BEFORE_PAST_THRESHOLD = 6_000_000_00; // Rs 60 L, already past the Rs 50 L line
const ONE_LAKH_PAISE = 1_00_000_00;

describe('PartySalesAggregateService.computeTcs - 206C(1H) sunset', () => {
  it('computes TCS for an invoice dated before 1 Apr 2025', () => {
    const tcs = svc.computeTcs(
      ONE_LAKH_PAISE,
      BEFORE_PAST_THRESHOLD,
      { aato: CR_12_AATO },
      new Date('2025-03-31T00:00:00.000Z'),
    );
    expect(tcs).toBe(Math.round(ONE_LAKH_PAISE * 0.001)); // 0.1%
  });

  it('returns 0 for an invoice dated on 1 Apr 2025 (abolished)', () => {
    const tcs = svc.computeTcs(
      ONE_LAKH_PAISE,
      BEFORE_PAST_THRESHOLD,
      { aato: CR_12_AATO },
      new Date('2025-04-01T00:00:00.000Z'),
    );
    expect(tcs).toBe(0);
  });

  it('returns 0 for an invoice dated after 1 Apr 2025', () => {
    const tcs = svc.computeTcs(
      ONE_LAKH_PAISE,
      BEFORE_PAST_THRESHOLD,
      { aato: CR_12_AATO },
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(tcs).toBe(0);
  });

  it('still returns 0 for a small firm before the sunset', () => {
    const tcs = svc.computeTcs(
      ONE_LAKH_PAISE,
      BEFORE_PAST_THRESHOLD,
      { aato: 50 }, // Rs 5 Cr, below the Rs 10 Cr trigger
      new Date('2025-03-31T00:00:00.000Z'),
    );
    expect(tcs).toBe(0);
  });
});
