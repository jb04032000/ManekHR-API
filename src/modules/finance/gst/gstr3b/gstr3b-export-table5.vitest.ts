/**
 * Phase 15-05 — GSTR-3B Table 5 export shape regression test (executable suite)
 *
 * Companion to the plan-path marker at:
 *   zari360-backend/__tests__/unit/gstr3b-export-table5.spec.ts
 *
 * This is the file actually executed by Vitest (matches `src/**\/*.vitest.ts`
 * include glob in vitest.config.ts). It lives next to the SUT (not under
 * `__tests__/`) so it is processed by Vitest's default esbuild transform —
 * the SWC integration plugin in vitest.config.ts is intentionally scoped to
 * `__tests__/` paths only and would otherwise require all imported schemas
 * to declare explicit `@Prop({ type })` options (Firm schema does not).
 *
 * Guards against regression of F-12 CR-04 — the GSTN GSTR-3B JSON schema v3.1
 * shape fix where `inward_sup.isup_details` was changed from an object to a
 * 4-element array of `{ ty, inter, intra }` rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators. The `@Prop` decorator on transitively
// imported schemas (Firm, SaleInvoice, PurchaseBill, LedgerEntry,
// Gstr3bAdjustment) inspects `Reflect.getMetadata('design:type', ...)` at
// class-definition time. Vitest's default esbuild transform does not emit
// `design:type` metadata for unannotated `@Prop()` fields, so the real
// decorator throws "Cannot determine a type" the moment the schema module
// loads. Replacing the decorators with no-ops sidesteps the schema-loading
// concern entirely — this test exercises only the pure-function shape of
// `exportJson()` and never touches a Mongoose model or DB.
vi.mock('@nestjs/mongoose', () => {
  // Schema files call chainable methods (`.index()`, `.virtual()`, `.pre()`,
  // `.post()`, `.method()`, `.set()`) on the result of `createForClass`.
  // Return a Proxy that responds to any method name with a no-op function
  // returning the same proxy — preserves `Schema.index(...).index(...)` style.
  const chainableProxy: any = new Proxy(
    {},
    {
      get: (_target, _prop) => () => chainableProxy,
    },
  );
  return {
    Prop: () => () => {},
    Schema: () => (target: any) => target,
    SchemaFactory: { createForClass: () => chainableProxy },
    InjectModel: () => () => {},
    raw: (v: any) => v,
    MongooseModule: { forFeature: () => ({}), forRoot: () => ({}) },
  };
});

import { Gstr3bService, type Gstr3bAutoReport } from './gstr3b.service';

// Helper: build a fully-populated Gstr3bAutoReport with sec_5 paise values
// matching the test fixture. All other fields are zeroed; exportJson reads
// every section, so each must be present and numeric.
function buildReportWithSec5(sec5: Gstr3bAutoReport['sec_5']): Gstr3bAutoReport {
  const zeroTax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  return {
    gstin: '24AAAAA0000A1Z5',
    fp: '042026',
    sec_3_1_a: { txval: 0, ...zeroTax },
    sec_3_1_b: { txval: 0, igst: 0, cess: 0 },
    sec_3_1_c: { txval: 0 },
    sec_3_1_d: { txval: 0, ...zeroTax },
    sec_3_1_e: { txval: 0 },
    sec_3_2: { to_unreg: [], to_comp: [], to_uin: [] },
    sec_4A_1: { igst: 0, cess: 0 },
    sec_4A_3: { ...zeroTax },
    sec_4A_5: { ...zeroTax },
    sec_4B_1: { ...zeroTax },
    sec_4B_2: { ...zeroTax },
    sec_4D: { ...zeroTax },
    sec_5: sec5,
    sec_6_1: { ...zeroTax },
  };
}

describe('Gstr3bService.exportJson — Table 5 (CR-04 regression)', () => {
  let service: Gstr3bService;

  beforeEach(() => {
    // Construct with null models — exportJson never touches them after we stub
    // getReport below.
    service = new (Gstr3bService as any)(null, null, null, null, null);
  });

  it('returns inward_sup.isup_details as a 4-element array (Array.isArray, toHaveLength(4))', async () => {
    // Arrange: seeded paise values, all distinct so a swap would be detectable.
    const sec5 = {
      exempt_inter: 100_00, exempt_intra: 200_00,         // GST row source
      non_gst_inter: 300_00, non_gst_intra: 400_00,       // NONGST row source
      nil_inter: 500_00, nil_intra: 600_00,               // NILSUP row source
      composition_inter: 700_00, composition_intra: 800_00, // COMPOSI row source
    };
    const report = buildReportWithSec5(sec5);

    // Stub getReport — exportJson is the only thing under test.
    vi.spyOn(service, 'getReport').mockResolvedValue({
      auto: report,
      adjustments: {},
      nov2025Locked: false,
      finalValues: {},
    });

    // Act
    const { payload } = await service.exportJson('ws1', 'firm1', '042026');
    const isup = (payload as any).inward_sup.isup_details;

    // Assert 1: shape — array with exactly 4 elements
    expect(Array.isArray(isup)).toBe(true);
    expect(isup).toHaveLength(4);

    // Assert 2: ty values exactly ['GST', 'NONGST', 'NILSUP', 'COMPOSI'] in order
    const tys = isup.map((e: any) => e.ty);
    expect(tys).toEqual(['GST', 'NONGST', 'NILSUP', 'COMPOSI']);

    // Assert 3: each row has numeric inter / intra fields
    for (const row of isup) {
      expect(typeof row.inter).toBe('number');
      expect(typeof row.intra).toBe('number');
    }

    // Assert 4: per-row inter/intra mapping (paise → rupees, derived from
    // gstr3b.service.ts L1064-1086 mapping):
    //   GST     ← exempt_*
    //   NONGST  ← non_gst_*
    //   NILSUP  ← nil_*
    //   COMPOSI ← composition_*
    expect(isup[0]).toEqual({ ty: 'GST', inter: 100, intra: 200 });
    expect(isup[1]).toEqual({ ty: 'NONGST', inter: 300, intra: 400 });
    expect(isup[2]).toEqual({ ty: 'NILSUP', inter: 500, intra: 600 });
    expect(isup[3]).toEqual({ ty: 'COMPOSI', inter: 700, intra: 800 });

    // Assert 5: paise-integer no-drift invariant. Sum of all 8 input paise
    // fields equals the sum of all 4×(inter+intra) rupees × 100 — exactly,
    // no floating-point error — because each cell crosses the toRs boundary
    // independently and the inputs were chosen as integer paise.
    const inputPaiseSum =
      sec5.exempt_inter + sec5.exempt_intra +
      sec5.non_gst_inter + sec5.non_gst_intra +
      sec5.nil_inter + sec5.nil_intra +
      sec5.composition_inter + sec5.composition_intra;
    const outputRupeeSum = isup.reduce(
      (acc: number, row: any) => acc + row.inter + row.intra,
      0,
    );
    expect(outputRupeeSum * 100).toBe(inputPaiseSum);
  });

  it('handles odd-paise values without floating-point drift via paise→rupee per-cell rounding', async () => {
    // Arrange: paise values that exercise 2-decimal rounding (e.g. 12345 paise = 123.45 INR).
    const sec5 = {
      exempt_inter: 12345, exempt_intra: 67,
      non_gst_inter: 99, non_gst_intra: 100,
      nil_inter: 1, nil_intra: 2,
      composition_inter: 50_00, composition_intra: 9999,
    };
    const report = buildReportWithSec5(sec5);

    vi.spyOn(service, 'getReport').mockResolvedValue({
      auto: report,
      adjustments: {},
      nov2025Locked: false,
      finalValues: {},
    });

    const { payload } = await service.exportJson('ws1', 'firm1', '042026');
    const isup = (payload as any).inward_sup.isup_details;

    // Each cell's rupee value matches paise/100 to 2 decimal places exactly.
    expect(isup[0]).toEqual({ ty: 'GST', inter: 123.45, intra: 0.67 });
    expect(isup[1]).toEqual({ ty: 'NONGST', inter: 0.99, intra: 1 });
    expect(isup[2]).toEqual({ ty: 'NILSUP', inter: 0.01, intra: 0.02 });
    expect(isup[3]).toEqual({ ty: 'COMPOSI', inter: 50, intra: 99.99 });
  });

  it('emits zero rupees for all four rows when sec_5 is fully zero (empty-period filing safe)', async () => {
    const sec5 = {
      exempt_inter: 0, exempt_intra: 0,
      non_gst_inter: 0, non_gst_intra: 0,
      nil_inter: 0, nil_intra: 0,
      composition_inter: 0, composition_intra: 0,
    };
    const report = buildReportWithSec5(sec5);

    vi.spyOn(service, 'getReport').mockResolvedValue({
      auto: report,
      adjustments: {},
      nov2025Locked: false,
      finalValues: {},
    });

    const { payload } = await service.exportJson('ws1', 'firm1', '042026');
    const isup = (payload as any).inward_sup.isup_details;

    expect(isup).toHaveLength(4);
    for (const row of isup) {
      expect(row.inter).toBe(0);
      expect(row.intra).toBe(0);
    }
    // ty order preserved even with all-zero values.
    expect(isup.map((r: any) => r.ty)).toEqual(['GST', 'NONGST', 'NILSUP', 'COMPOSI']);
  });
});
