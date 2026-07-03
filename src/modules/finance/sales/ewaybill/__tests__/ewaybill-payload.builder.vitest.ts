import { describe, it, expect } from 'vitest';
import { EwaybillPayloadBuilder, type TransportInput } from '../ewaybill-payload.builder';

/**
 * Pure unit test for the EWB payload builder - covers docType/subSupplyType derivation
 * including the delivery-challan path (added with challan e-Way support). The builder has
 * no injected deps, so it runs without the Mongo/env test harness.
 */
const b = new EwaybillPayloadBuilder();
const firm = { gstin: '24AAACR4521K1Z9', firmName: 'Firm' };
const party = { gstin: '24AAACR4521K1Z9', name: 'Party' };
const transport: TransportInput = { transMode: '1', transDistance: 10 };
const base = { voucherDate: '2026-05-01', voucherNumber: 'X1', lineItems: [] };

describe('EwaybillPayloadBuilder.build docType/subSupplyType', () => {
  it('maps delivery_challan voucherType to docType CHL', () => {
    const p = b.build({ ...base, voucherType: 'delivery_challan' }, firm, party, transport);
    expect(p.docType).toBe('CHL');
  });

  it('maps a job_work challan to subSupplyType 4 (Job Work)', () => {
    const p = b.build(
      { ...base, voucherType: 'delivery_challan', challanType: 'job_work' },
      firm,
      party,
      transport,
    );
    expect(p.subSupplyType).toBe(4);
  });

  it('keeps sale_invoice as docType INV + subSupplyType 1 (regression guard)', () => {
    const p = b.build({ ...base, voucherType: 'sale_invoice' }, firm, party, transport);
    expect(p.docType).toBe('INV');
    expect(p.subSupplyType).toBe(1);
  });
});

describe('EwaybillPayloadBuilder.isGujaratTextileExempt', () => {
  it('exempts intra-Gujarat textile HSN (50-63) but not inter-state', () => {
    const textile = [
      {
        hsnCd: '5208',
        productName: 'x',
        quantity: 1,
        qtyUnit: 'M',
        taxableAmount: 1,
        sgstRate: 0,
        cgstRate: 0,
        igstRate: 0,
        cessRate: 0,
      },
    ];
    expect(b.isGujaratTextileExempt(24, 24, textile)).toBe(true);
    expect(b.isGujaratTextileExempt(24, 27, textile)).toBe(false); // inter-state
  });
});
