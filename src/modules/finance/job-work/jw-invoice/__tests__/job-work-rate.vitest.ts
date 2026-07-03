import { describe, it, expect } from 'vitest';
import { resolveJobWorkRate } from '../job-work-rate';
import { gstHalves, lineAmountPaise, effectiveRateCentiPaise } from '../../../common/precision';

describe('resolveJobWorkRate - textile job-work GST, eff 22 Sep 2025', () => {
  it('general textile (embroidery/stitching/tailoring) is 5%', () => {
    expect(resolveJobWorkRate('general_textile')).toBe(5);
  });
  it('dyeing/printing (legacy combined) is 18%', () => {
    expect(resolveJobWorkRate('dyeing_printing')).toBe(18);
  });
  it('R5: printing is 18% (residuary process)', () => {
    expect(resolveJobWorkRate('printing')).toBe(18);
  });
  it('R5: embroidery is 5% (general textile process)', () => {
    expect(resolveJobWorkRate('embroidery')).toBe(5);
  });
  it('residuary/other is 18%', () => {
    expect(resolveJobWorkRate('other')).toBe(18);
  });
  it('defaults to 5% when unset (backward-compatible with existing data)', () => {
    expect(resolveJobWorkRate(undefined)).toBe(5);
  });
});

describe('job-work per-line tax sum (post path arithmetic)', () => {
  it('sums 5% and 18% lines independently', () => {
    const lines = [
      { amountPaise: 1_000_00, taxRate: resolveJobWorkRate('general_textile') }, // Rs 1000 @ 5%
      { amountPaise: 1_000_00, taxRate: resolveJobWorkRate('dyeing_printing') }, // Rs 1000 @ 18%
    ];
    const taxAmt = lines.reduce((s, l) => s + Math.round(l.amountPaise * (l.taxRate / 100)), 0);
    // 100000 paise (Rs 1000) @ 5% = 5000 paise (Rs 50)
    // 100000 paise (Rs 1000) @ 18% = 18000 paise (Rs 180)
    // total = 23000 paise (Rs 230)
    expect(taxAmt).toBe(5000 + 18000);
  });
});

describe('job-work intrastate split = equal halves (GST-correct)', () => {
  it('Rs 101 at 5% -> CGST=SGST=253 each (not 253/252)', () => {
    // Old total-then-split gave 505 -> 253/252. Equal halves give 253/253, total 506.
    const h = gstHalves(10100, 5);
    expect(h).toEqual({ cgstPaise: 253, sgstPaise: 253 });
  });
});

describe('job-work line amount honors 4 dp rate', () => {
  it('Rs 10.005 x 100 = 100050 paise (4 dp), not 100100', () => {
    const amt = lineAmountPaise(
      100,
      effectiveRateCentiPaise({ rateCentiPaise: 100050, ratePaise: 1001 }),
    );
    expect(amt).toBe(100050);
  });
  it('falls back to ratePaise when centi absent', () => {
    const amt = lineAmountPaise(100, effectiveRateCentiPaise({ ratePaise: 1001 }));
    expect(amt).toBe(100100);
  });
});
