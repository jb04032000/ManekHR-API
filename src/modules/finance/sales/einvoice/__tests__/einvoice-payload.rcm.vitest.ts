import { describe, it, expect } from 'vitest';
import { EinvoicePayloadBuilder } from '../einvoice-payload.builder';

/**
 * 2c: the IRP TranDtls.RegRev flag must reflect the persisted per-invoice
 * isReverseCharge field (previously the builder read a field that did not exist
 * on the schema, so RegRev was always 'N').
 */
describe('EinvoicePayloadBuilder - reverse charge (RegRev)', () => {
  const builder = new EinvoicePayloadBuilder();

  const firm = {
    gstin: '24ABCDE1234F1Z5',
    firmName: 'Test Textiles',
    address: { line1: 'Ring Road', city: 'Surat', pincode: '395003' },
    aato: 0,
  };
  const party = {
    gstin: '24XYZAB5678C1Z3',
    name: 'Buyer Mills',
    address: { line1: 'Sahara Darwaja', city: 'Surat', pincode: '395002' },
  };
  const baseInvoice = {
    voucherNumber: 'INV-001',
    voucherType: 'sale_invoice',
    voucherDate: new Date('2025-10-01T00:00:00.000Z').toISOString(),
    placeOfSupplyStateCode: '24',
    grandTotalPaise: 11800,
    taxableValuePaise: 10000,
    cgstPaise: 900,
    sgstPaise: 900,
    igstPaise: 0,
    lineItems: [
      {
        itemName: 'Cotton fabric',
        hsnSacCode: '5208',
        qty: 1,
        ratePaise: 10000,
        taxRate: 18,
        taxableValuePaise: 10000,
        cgstPaise: 900,
        sgstPaise: 900,
        lineTotalPaise: 11800,
      },
    ],
  };

  it('maps isReverseCharge=true to RegRev=Y', () => {
    const payload = builder.build({ ...baseInvoice, isReverseCharge: true }, firm, party);
    expect(payload.TranDtls.RegRev).toBe('Y');
  });

  it('maps isReverseCharge=false to RegRev=N', () => {
    const payload = builder.build({ ...baseInvoice, isReverseCharge: false }, firm, party);
    expect(payload.TranDtls.RegRev).toBe('N');
  });

  it('defaults to RegRev=N when the flag is absent', () => {
    const payload = builder.build({ ...baseInvoice }, firm, party);
    expect(payload.TranDtls.RegRev).toBe('N');
  });
});

describe('EinvoicePayloadBuilder - credit note (CRN) preceding document', () => {
  const builder = new EinvoicePayloadBuilder();
  const firm = {
    gstin: '24ABCDE1234F1Z5',
    firmName: 'Test Textiles',
    address: { line1: 'Ring Road', city: 'Surat', pincode: '395003' },
    aato: 0,
  };
  const party = { gstin: '24XYZAB5678C1Z3', name: 'Buyer Mills' };
  const cn = {
    voucherNumber: 'CN-001',
    voucherType: 'credit_note',
    voucherDate: new Date('2025-10-05T00:00:00.000Z').toISOString(),
    sourceInvoiceNumber: 'INV-001',
    sourceInvoiceDate: new Date('2025-10-01T00:00:00.000Z').toISOString(),
    placeOfSupplyStateCode: '24',
    grandTotalPaise: 1180,
    taxableValuePaise: 1000,
    cgstPaise: 90,
    sgstPaise: 90,
    igstPaise: 0,
    lineItems: [
      {
        itemName: 'Cotton fabric',
        hsnSacCode: '5208',
        qty: 1,
        ratePaise: 1000,
        taxRate: 18,
        taxableValuePaise: 1000,
        cgstPaise: 90,
        sgstPaise: 90,
        lineTotalPaise: 1180,
      },
    ],
  };

  it('sets DocDtls.Typ=CRN and PrecDocDtls from the source invoice', () => {
    const payload = builder.build(cn, firm, party);
    expect(payload.DocDtls.Typ).toBe('CRN');
    expect(payload.PrecDocDtls).toEqual([{ InvNo: 'INV-001', InvDt: '01/10/2025' }]);
  });

  it('omits PrecDocDtls for a plain invoice', () => {
    const payload = builder.build(
      { ...cn, voucherType: 'sale_invoice', sourceInvoiceNumber: undefined },
      firm,
      party,
    );
    expect(payload.DocDtls.Typ).toBe('INV');
    expect(payload.PrecDocDtls).toBeUndefined();
  });
});
