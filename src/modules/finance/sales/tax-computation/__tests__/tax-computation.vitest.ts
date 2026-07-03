import { describe, it, expect } from 'vitest';
import { TaxComputationService } from '../tax-computation.service';

const svc = new TaxComputationService({
  findApplicableForHsn: () => Promise.resolve(null),
} as any);

function line(over: Partial<any> = {}) {
  return {
    qty: 2,
    ratePaise: 10000,
    discountPct: 0,
    discountFlatPaise: 0,
    isTaxInclusive: false,
    taxRate: 5,
    cessRate: 0,
    hsnCode: '5208',
    ...over,
  };
}

describe('TaxComputationService.compute - 4 dp rate', () => {
  it('uses rateCentiPaise when present (Rs 10.005 x 100 = taxable 100050)', () => {
    const r = svc.compute({
      lines: [line({ qty: 100, ratePaise: 1001, rateCentiPaise: 100050, taxRate: 0 })],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '24',
      placeOfSupplyStateCode: '24',
      roundingPolicy: 'half_up',
    });
    // 4 dp -> 100050 paise; 2 dp would have been 1001*100 = 100100. Difference proves 4 dp is used.
    expect(r.subtotalPaise).toBe(100050);
    expect(r.taxableValuePaise).toBe(100050);
  });

  it('falls back to ratePaise when rateCentiPaise absent (existing rows unchanged)', () => {
    const r = svc.compute({
      lines: [line({ qty: 100, ratePaise: 1001, taxRate: 0 })],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '24',
      placeOfSupplyStateCode: '24',
      roundingPolicy: 'half_up',
    });
    expect(r.subtotalPaise).toBe(100100);
  });
});

describe('TaxComputationService.compute - golden vectors', () => {
  it('intrastate 5% on Rs 200 -> CGST=SGST=500, total 21000', () => {
    const r = svc.compute({
      lines: [line()],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '24',
      placeOfSupplyStateCode: '24',
      roundingPolicy: 'half_up',
    });
    expect(r.cgstPaise).toBe(500);
    expect(r.sgstPaise).toBe(500);
    expect(r.igstPaise).toBe(0);
    expect(r.grandTotalPaise).toBe(21000);
    expect(r.roundOffPaise).toBe(0);
  });

  it('interstate 5% on Rs 200 -> IGST=1000', () => {
    const r = svc.compute({
      lines: [line()],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '27',
      placeOfSupplyStateCode: '27',
      roundingPolicy: 'half_up',
    });
    expect(r.igstPaise).toBe(1000);
    expect(r.cgstPaise).toBe(0);
    expect(r.grandTotalPaise).toBe(21000);
  });

  it('round_off_to_rupee: Rs 100.50 at 18% -> roundOff 40, grand 11900', () => {
    const r = svc.compute({
      lines: [line({ qty: 1, ratePaise: 10050, taxRate: 18 })],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '24',
      placeOfSupplyStateCode: '24',
      roundingPolicy: 'round_off_to_rupee',
    });
    // taxable 10050; each half = round(10050*9/100)=round(904.5)=905; tax 1810
    expect(r.cgstPaise).toBe(905);
    expect(r.sgstPaise).toBe(905);
    // raw 10050+1810=11860 -> nearest rupee 11900, roundOff 40
    expect(r.roundOffPaise).toBe(40);
    expect(r.grandTotalPaise).toBe(11900);
  });

  it('reconciliation invariant: taxable + tax + roundOff == grandTotal', () => {
    const r = svc.compute({
      lines: [line({ qty: 1, ratePaise: 10050, taxRate: 18 })],
      additionalCharges: [],
      firmStateCode: '24',
      partyStateCode: '24',
      placeOfSupplyStateCode: '24',
      roundingPolicy: 'round_off_to_rupee',
    });
    expect(
      r.taxableValuePaise + r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise + r.roundOffPaise,
    ).toBe(r.grandTotalPaise);
  });
});

// ── PREVIEW == POSTED PARITY CONTRACT ───────────────────────────────────────
// These canonical vectors lock the backend posting engine (compute) to the web
// preview engine (computeTaxClient). The exact same PARITY_VECTORS array +
// expected numbers MUST exist in:
//   crewroster-web/lib/finance/taxComputeClient.spec.ts
// If you change either tax engine, update BOTH so the byte-for-byte "what you
// preview is what posts" promise stays enforced. Any drift fails one side here.
type ParityVector = {
  name: string;
  lines: Record<string, unknown>[];
  charges?: Record<string, unknown>[];
  firmStateCode: string;
  placeOfSupplyStateCode: string;
  roundingPolicy?: 'half_up' | 'round_off_to_rupee';
  tcsPaise?: number;
  expect: Record<string, number>;
};

const PARITY_VECTORS: ParityVector[] = [
  {
    name: 'intra 18% (qty100 x Rs100) -> CGST=SGST=90000',
    lines: [{ qty: 100, ratePaise: 10000, taxRate: 18 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '24',
    expect: {
      taxableValuePaise: 1000000,
      cgstPaise: 90000,
      sgstPaise: 90000,
      igstPaise: 0,
      grandTotalPaise: 1180000,
    },
  },
  {
    name: 'inter 18% (qty100 x Rs100) -> IGST=180000',
    lines: [{ qty: 100, ratePaise: 10000, taxRate: 18 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '27',
    expect: { cgstPaise: 0, sgstPaise: 0, igstPaise: 180000, grandTotalPaise: 1180000 },
  },
  {
    name: 'intra 5% (Rs100) -> half = 2.5%',
    lines: [{ qty: 1, ratePaise: 10000, taxRate: 5 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '24',
    expect: { cgstPaise: 250, sgstPaise: 250, grandTotalPaise: 10500 },
  },
  {
    name: 'intra 28% + 12% cess (Rs100)',
    lines: [{ qty: 1, ratePaise: 10000, taxRate: 28, cessRate: 12 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '24',
    expect: { cgstPaise: 1400, sgstPaise: 1400, cessPaise: 1200, grandTotalPaise: 14000 },
  },
  {
    name: 'inter + taxable freight 18% (line @0%)',
    lines: [{ qty: 1, ratePaise: 10000, taxRate: 0 }],
    charges: [{ label: 'Freight', amountPaise: 10000, isTaxable: true, taxRate: 18 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '27',
    expect: {
      igstPaise: 1800,
      taxableValuePaise: 20000,
      additionalChargesPaise: 10000,
      grandTotalPaise: 21800,
    },
  },
  {
    name: 'round_off_to_rupee (Rs123.45 @0%) -> -45',
    lines: [{ qty: 1, ratePaise: 12345, taxRate: 0 }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '24',
    roundingPolicy: 'round_off_to_rupee',
    expect: { roundOffPaise: -45, grandTotalPaise: 12300 },
  },
  {
    name: 'tax-inclusive 18% (Rs118 incl) -> taxable Rs100',
    lines: [{ qty: 1, ratePaise: 11800, taxRate: 18, isTaxInclusive: true }],
    firmStateCode: '24',
    placeOfSupplyStateCode: '24',
    expect: { taxableValuePaise: 10000, cgstPaise: 900, sgstPaise: 900, grandTotalPaise: 11800 },
  },
];

describe('TaxComputationService.compute - parity contract (must match web computeTaxClient)', () => {
  for (const v of PARITY_VECTORS) {
    it(v.name, () => {
      const r = svc.compute({
        lines: v.lines.map((l) => line(l)),
        additionalCharges: (v.charges ?? []) as any,
        firmStateCode: v.firmStateCode,
        partyStateCode: v.placeOfSupplyStateCode,
        placeOfSupplyStateCode: v.placeOfSupplyStateCode,
        roundingPolicy: v.roundingPolicy ?? 'half_up',
        tcsPaise: v.tcsPaise,
      });
      for (const [key, want] of Object.entries(v.expect)) {
        expect((r as unknown as Record<string, number>)[key], `${v.name}: ${key}`).toBe(want);
      }
      // Reconciliation invariant (no non-taxable charges in any parity vector).
      expect(
        r.taxableValuePaise +
          r.cgstPaise +
          r.sgstPaise +
          r.igstPaise +
          r.cessPaise +
          r.roundOffPaise,
      ).toBe(r.grandTotalPaise);
    });
  }
});
