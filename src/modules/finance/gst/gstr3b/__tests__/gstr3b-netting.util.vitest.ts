import { describe, it, expect } from 'vitest';
import { netOutward31a, netItc4a } from '../gstr3b-netting.util';

describe('netOutward31a', () => {
  const gross = { txval: 100000, igst: 0, cgst: 9000, sgst: 9000 };

  it('returns the gross figures unchanged when there are no credit notes', () => {
    expect(netOutward31a(gross, { txval: 0, igst: 0, cgst: 0, sgst: 0 })).toEqual({
      txval: 100000,
      igst: 0,
      cgst: 9000,
      sgst: 9000,
      cess: 0,
    });
  });

  it('subtracts credit-note taxable value and tax (3.1(a) is net of CDN for the period)', () => {
    expect(netOutward31a(gross, { txval: 20000, igst: 0, cgst: 1800, sgst: 1800 })).toEqual({
      txval: 80000,
      igst: 0,
      cgst: 7200,
      sgst: 7200,
      cess: 0,
    });
  });

  it('clamps each cell at 0 when credit notes exceed sales (portal rejects negative 3.1(a))', () => {
    expect(
      netOutward31a(
        { txval: 10000, igst: 0, cgst: 900, sgst: 900 },
        { txval: 25000, igst: 0, cgst: 2250, sgst: 2250 },
      ),
    ).toEqual({ txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  });

  it('nets inter-state (IGST) sales independently', () => {
    expect(
      netOutward31a(
        { txval: 50000, igst: 9000, cgst: 0, sgst: 0 },
        { txval: 10000, igst: 1800, cgst: 0, sgst: 0 },
      ),
    ).toEqual({ txval: 40000, igst: 7200, cgst: 0, sgst: 0, cess: 0 });
  });

  it('clamps each cell independently - taxable hits 0 while tax cells stay positive', () => {
    // CN taxable exceeds gross taxable (-> clamped to 0), but CN tax is below gross tax
    // (-> stays positive). Confirms the clamp is per-cell, not a single global floor.
    expect(
      netOutward31a(
        { txval: 10000, igst: 0, cgst: 5000, sgst: 5000 },
        { txval: 25000, igst: 0, cgst: 1000, sgst: 1000 },
      ),
    ).toEqual({ txval: 0, igst: 0, cgst: 4000, sgst: 4000, cess: 0 });
  });

  it('treats missing fields as zero', () => {
    expect(netOutward31a({ txval: 5000 }, {})).toEqual({
      txval: 5000,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
    });
  });
});

describe('netItc4a', () => {
  it('returns gross ITC unchanged when there are no debit-note reversals', () => {
    expect(netItc4a({ igst: 0, cgst: 5000, sgst: 5000 }, {})).toEqual({
      igst: 0,
      cgst: 5000,
      sgst: 5000,
      cess: 0,
    });
  });

  it('subtracts purchase debit-note ITC reversals from standard ITC', () => {
    expect(
      netItc4a({ igst: 0, cgst: 5000, sgst: 5000 }, { igst: 0, cgst: 1000, sgst: 1000 }),
    ).toEqual({ igst: 0, cgst: 4000, sgst: 4000, cess: 0 });
  });

  it('clamps at 0 when reversals exceed the period ITC', () => {
    expect(netItc4a({ igst: 2000 }, { igst: 5000 })).toEqual({
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
    });
  });

  it('clamps each cell independently - cgst hits 0 while sgst stays positive', () => {
    expect(
      netItc4a({ igst: 0, cgst: 1000, sgst: 5000 }, { igst: 0, cgst: 4000, sgst: 1000 }),
    ).toEqual({ igst: 0, cgst: 0, sgst: 4000, cess: 0 });
  });
});
