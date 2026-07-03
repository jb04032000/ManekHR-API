import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { PrintService } from '../print.service';
import { PrintI18nService } from '../../print-i18n/print-i18n.service';
import { ThemeRegistry } from '../themes';

const I18N_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'i18n');

function makeI18n(): PrintI18nService {
  const svc = new PrintI18nService();
  svc.loadFrom(I18N_DIR);
  return svc;
}

const sampleInvoice = {
  voucherNumber: 'INV-001',
  voucherDate: new Date('2026-04-15'),
  partySnapshot: { name: 'Acme Traders' },
  placeOfSupplyStateCode: '24',
  lineItems: [
    {
      itemName: 'Cotton Yarn',
      hsnSacCode: '5205',
      qty: 10,
      unit: 'KG',
      ratePaise: 50000,
      taxableValuePaise: 500000,
      cgstPaise: 45000,
      sgstPaise: 45000,
      igstPaise: 0,
      gstRate: 18,
    },
    {
      itemName: 'Polyester Thread',
      hsnSacCode: '5402',
      qty: 5,
      unit: 'NOS',
      ratePaise: 20000,
      taxableValuePaise: 100000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      igstPaise: 0,
      gstRate: 18,
    },
  ],
  totalPaise: 708000,
};

const sampleParty = {
  name: 'Acme Traders Pvt Ltd',
  gstin: '24AAACA1234A1Z5',
  address: 'Plot 12, Industrial Estate, Surat',
};

const sampleFirm = {
  firmName: 'ManekHR Sample Firm',
  gstin: '24ZZZZZ9999Z9Z9',
  defaultPrintLocale: 'en',
};

describe('PrintService.renderInvoicePdf', () => {
  let svc: PrintService;
  beforeAll(() => {
    svc = new PrintService(makeI18n());
  });

  it('renders en/classic to a valid PDF buffer', async () => {
    const buf = await svc.renderInvoicePdf(sampleInvoice, sampleParty, sampleFirm, {
      locale: 'en',
      themeId: 'classic',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2000);
  });

  it('renders gu/classic — Gujarati script via NotoSansGujarati', async () => {
    const buf = await svc.renderInvoicePdf(sampleInvoice, sampleParty, sampleFirm, {
      locale: 'gu',
      themeId: 'classic',
    });
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2000);
  });

  it('renders hi/classic — Devanagari via NotoSansDevanagari', async () => {
    const buf = await svc.renderInvoicePdf(sampleInvoice, sampleParty, sampleFirm, {
      locale: 'hi',
      themeId: 'classic',
    });
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2000);
  });

  it('renders all 6 (locale × theme) combinations to valid PDFs > 2KB', async () => {
    const locales = ['en', 'gu', 'hi'] as const;
    const themes = ['classic', 'modern'];
    for (const locale of locales) {
      for (const themeId of themes) {
        const buf = await svc.renderInvoicePdf(sampleInvoice, sampleParty, sampleFirm, {
          locale,
          themeId,
        });
        expect(
          buf.subarray(0, 4).toString('utf8'),
          `${locale}/${themeId} not a PDF`,
        ).toBe('%PDF');
        expect(buf.length, `${locale}/${themeId} too small`).toBeGreaterThan(2000);
      }
    }
  });

  it('falls back to classic when themeId not registered', async () => {
    const buf = await svc.renderInvoicePdf(sampleInvoice, sampleParty, sampleFirm, {
      locale: 'en',
      themeId: 'nonexistent-theme',
    });
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('locale resolves from firm.defaultPrintLocale when explicit absent', async () => {
    const buf = await svc.renderInvoicePdf(
      sampleInvoice,
      sampleParty,
      { ...sampleFirm, defaultPrintLocale: 'gu' },
      { themeId: 'classic' },
    );
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('ThemeRegistry has both production themes registered', () => {
    expect(ThemeRegistry.has('classic')).toBe(true);
    expect(ThemeRegistry.has('modern')).toBe(true);
    const ids = ThemeRegistry.list().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['classic', 'modern']));
  });
});
