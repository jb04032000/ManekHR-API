import { describe, it, expect } from 'vitest';
import {
  rcmOutputTaxLines,
  supplierCreditorBasePaise,
  RCM_OUTPUT_CODE,
} from '../purchase-bill-rcm.rules';

describe('rcmOutputTaxLines (RCM output-tax liability)', () => {
  it('returns nothing for a non-reverse-charge bill', () => {
    expect(rcmOutputTaxLines({ cgstPaise: 900, sgstPaise: 900 }, true)).toEqual([]);
    expect(rcmOutputTaxLines({ isReverseCharge: false, igstPaise: 1800 }, false)).toEqual([]);
  });

  it('credits CGST + SGST payable for an intra-state RCM bill', () => {
    expect(
      rcmOutputTaxLines({ isReverseCharge: true, cgstPaise: 900, sgstPaise: 900 }, true),
    ).toEqual([
      { accountCode: RCM_OUTPUT_CODE.cgst, paise: 900 },
      { accountCode: RCM_OUTPUT_CODE.sgst, paise: 900 },
    ]);
  });

  it('credits IGST payable for an inter-state RCM bill', () => {
    expect(rcmOutputTaxLines({ isReverseCharge: true, igstPaise: 1800 }, false)).toEqual([
      { accountCode: RCM_OUTPUT_CODE.igst, paise: 1800 },
    ]);
  });

  it('skips zero-amount components', () => {
    expect(
      rcmOutputTaxLines({ isReverseCharge: true, cgstPaise: 900, sgstPaise: 0 }, true),
    ).toEqual([{ accountCode: RCM_OUTPUT_CODE.cgst, paise: 900 }]);
    expect(rcmOutputTaxLines({ isReverseCharge: true, igstPaise: 0 }, false)).toEqual([]);
  });
});

describe('supplierCreditorBasePaise (RCM creditor = taxable, not grand total)', () => {
  it('owes the supplier only the taxable value under reverse charge', () => {
    expect(
      supplierCreditorBasePaise({
        isReverseCharge: true,
        taxableValuePaise: 100000,
        grandTotalPaise: 118000,
      }),
    ).toBe(100000);
  });

  it('owes the supplier the full grand total for a normal bill', () => {
    expect(
      supplierCreditorBasePaise({
        isReverseCharge: false,
        taxableValuePaise: 100000,
        grandTotalPaise: 118000,
      }),
    ).toBe(118000);
    expect(supplierCreditorBasePaise({ taxableValuePaise: 100000, grandTotalPaise: 118000 })).toBe(
      118000,
    );
  });
});
