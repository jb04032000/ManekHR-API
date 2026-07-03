import { TaxComputationService, TaxComputationInput } from './tax-computation.service';
import { Types } from 'mongoose';

const dummyItemId = new Types.ObjectId();

/** Helper: minimal intra-state single-line input */
function makeInput(overrides: Partial<TaxComputationInput> = {}): TaxComputationInput {
  return {
    lines: [],
    additionalCharges: [],
    firmStateCode: '24',
    partyStateCode: '24',
    placeOfSupplyStateCode: '24',
    roundingPolicy: 'half_up',
    ...overrides,
  };
}

describe('TaxComputationService', () => {
  let service: TaxComputationService;

  beforeEach(() => {
    service = new TaxComputationService();
  });

  it('intra-state single line: CGST and SGST are equal halves (18%)', () => {
    // 100 units × ₹100 = ₹10,000 taxable
    // CGST 9% = ₹900; SGST 9% = ₹900; grand = ₹11,800
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Widget',
          qty: 100,
          unit: 'pcs',
          ratePaise: 10000,        // ₹100
          discountPct: 0,
          taxRate: 18,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.taxableValuePaise).toBe(1000000);  // 100 × 10000 = 1,000,000 paise
    expect(result.cgstPaise).toBe(90000);            // 9% of 1,000,000
    expect(result.sgstPaise).toBe(90000);            // 9%
    expect(result.igstPaise).toBe(0);
    expect(result.grandTotalPaise).toBe(1180000);    // 1,000,000 + 90,000 + 90,000
  });

  it('inter-state single line: IGST equals full GST (18%), CGST/SGST = 0', () => {
    const input = makeInput({
      partyStateCode: '27',              // Maharashtra (≠ Gujarat 24)
      placeOfSupplyStateCode: '27',
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Widget',
          qty: 100,
          unit: 'pcs',
          ratePaise: 10000,
          discountPct: 0,
          taxRate: 18,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.igstPaise).toBe(180000);   // 18% of 1,000,000
    expect(result.cgstPaise).toBe(0);
    expect(result.sgstPaise).toBe(0);
    expect(result.grandTotalPaise).toBe(1180000);
  });

  it('tax-inclusive line: taxable value back-calculated from gross (18%)', () => {
    // 1 unit × ₹118 inclusive @ 18% → taxable = ₹100 → CGST=₹9 SGST=₹9
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Inclusive Item',
          qty: 1,
          unit: 'pcs',
          ratePaise: 11800,    // ₹118 in paise
          discountPct: 0,
          taxRate: 18,
          cessRate: 0,
          isTaxInclusive: true,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.taxableValuePaise).toBe(10000);  // ₹100
    expect(result.cgstPaise).toBe(900);            // ₹9
    expect(result.sgstPaise).toBe(900);            // ₹9
    expect(result.grandTotalPaise).toBe(11800);
  });

  it('5% rate split: CGST 2.5% + SGST 2.5%', () => {
    // 1 unit × ₹100 @ 5% intra → CGST 250p + SGST 250p
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Staple',
          qty: 1,
          unit: 'pcs',
          ratePaise: 10000,    // ₹100
          discountPct: 0,
          taxRate: 5,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.cgstPaise).toBe(250);   // 2.5% of 10000
    expect(result.sgstPaise).toBe(250);
    expect(result.grandTotalPaise).toBe(10500);
  });

  it('cess on tobacco-like item: cess computed on taxable value', () => {
    // 1 unit × ₹100 @ 28% + 12% cess
    // taxable = 10000p; cgst = 1400p; sgst = 1400p; cess = 1200p; total = 14000p
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Pan Masala',
          qty: 1,
          unit: 'pcs',
          ratePaise: 10000,
          discountPct: 0,
          taxRate: 28,
          cessRate: 12,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.cessPaise).toBe(1200);    // 12% of 10000
    expect(result.cgstPaise).toBe(1400);    // 14%
    expect(result.sgstPaise).toBe(1400);    // 14%
    expect(result.grandTotalPaise).toBe(14000);
  });

  it('additional charge taxable: freight contributes GST', () => {
    // 1 line: 1 unit × ₹100 @ 0% tax
    // freight: ₹100 @ 18% taxable
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Goods',
          qty: 1,
          unit: 'pcs',
          ratePaise: 10000,
          discountPct: 0,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
      additionalCharges: [
        { label: 'Freight', amountPaise: 10000, isTaxable: true, taxRate: 18 },
      ],
    });

    const result = service.compute(input);
    // freight CGST = 9% of 10000 = 900; SGST = 900
    expect(result.cgstPaise).toBe(900);
    expect(result.sgstPaise).toBe(900);
    expect(result.additionalChargesPaise).toBe(10000);
    // grand = 10000 (line) + 10000 (freight) + 900 + 900 = 21800
    expect(result.grandTotalPaise).toBe(21800);
  });

  it('round-off enabled (round_off_to_rupee): paise truncated', () => {
    // Force a line total whose sum has paise remainder
    // 1 unit × ₹123.45 @ 0% = 12345 paise raw; rounded to 12300 → roundOff = -45
    const input = makeInput({
      roundingPolicy: 'round_off_to_rupee',
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Item',
          qty: 1,
          unit: 'pcs',
          ratePaise: 12345,
          discountPct: 0,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.roundOffPaise).toBe(-45);
    expect(result.grandTotalPaise).toBe(12300);
  });

  it('round-off disabled (half_up): roundOffPaise is always 0', () => {
    const input = makeInput({
      roundingPolicy: 'half_up',
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Item',
          qty: 1,
          unit: 'pcs',
          ratePaise: 12345,
          discountPct: 0,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.roundOffPaise).toBe(0);
    expect(result.grandTotalPaise).toBe(12345);
  });

  it('discount flat: taxable is lineGross after flat discount', () => {
    // 1 unit × ₹100 with discountFlatPaise=1000 (₹10) → taxable = 9000 paise
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Widget',
          qty: 1,
          unit: 'pcs',
          ratePaise: 10000,
          discountPct: 0,
          discountFlatPaise: 1000,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.taxableValuePaise).toBe(9000);
    expect(result.totalDiscountPaise).toBe(1000);
  });

  it('discount pct: taxable is lineGross after pct discount', () => {
    // 2 units × ₹100 with discountPct=10 → lineGross = 18000; taxable = 18000
    const input = makeInput({
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Widget',
          qty: 2,
          unit: 'pcs',
          ratePaise: 10000,
          discountPct: 10,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.taxableValuePaise).toBe(18000);
    expect(result.totalDiscountPaise).toBe(2000);   // 10% of 20000
  });

  it('tcs pass-through: tcsPaise included in rawTotal and returned', () => {
    const input = makeInput({
      tcsPaise: 5000,
      lines: [
        {
          itemId: dummyItemId,
          itemName: 'Widget',
          qty: 1,
          unit: 'pcs',
          ratePaise: 100000,  // ₹1000
          discountPct: 0,
          taxRate: 0,
          cessRate: 0,
          isTaxInclusive: false,
        },
      ],
    });

    const result = service.compute(input);
    expect(result.tcsPaise).toBe(5000);
    expect(result.grandTotalPaise).toBe(105000); // 100000 + 5000
  });
});
