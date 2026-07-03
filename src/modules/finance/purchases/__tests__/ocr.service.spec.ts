import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { OcrService } from '../ocr/ocr.service';
import { TesseractOcrAdapter } from '../ocr/tesseract.adapter';

// ─── Fixture factories ────────────────────────────────────────────────────────

function makeTesseractAdapter(overrides: Partial<TesseractOcrAdapter> = {}) {
  return {
    providerName: 'tesseract',
    extractVendorBill: vi.fn().mockResolvedValue({
      lineItems: [],
      confidence: 0,
      ocrStatus: 'manual',
      rawText: '[stub]',
    }),
    ...overrides,
  } as unknown as TesseractOcrAdapter;
}

function makeService(adapter?: Partial<TesseractOcrAdapter>) {
  const tesseract = makeTesseractAdapter(adapter);
  return { svc: new OcrService(tesseract as any), tesseract };
}

const VALID_PDF_BUFFER = Buffer.alloc(100);
const OVER_10MB_BUFFER = Buffer.alloc(10 * 1024 * 1024 + 1);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OcrService.extractVendorBill', () => {
  it('SC-4: rejects mimeType not in allowlist with BadRequestException', async () => {
    const { svc } = makeService();
    // We bypass OcrService routing and test the real TesseractOcrAdapter directly
    // because OcrService delegates validation to the adapter.
    const adapter = new TesseractOcrAdapter();
    await expect(adapter.extractVendorBill(VALID_PDF_BUFFER, 'text/plain'))
      .rejects.toThrow(BadRequestException);
  });

  it('SC-4: rejects fileBuffer.length > 10MB', async () => {
    const adapter = new TesseractOcrAdapter();
    await expect(adapter.extractVendorBill(OVER_10MB_BUFFER, 'application/pdf'))
      .rejects.toThrow(BadRequestException);
  });

  it('SC-4: confidence < 0.70 returns ocrStatus=manual (forces user review)', async () => {
    const { svc } = makeService({
      extractVendorBill: vi.fn().mockResolvedValue({
        lineItems: [], confidence: 0.50, ocrStatus: 'manual', rawText: '',
      }),
    });
    const result = await svc.extractVendorBill(VALID_PDF_BUFFER, 'application/pdf');
    expect(result.ocrStatus).toBe('manual');
  });

  it('SC-4: confidence >= 0.70 and < 0.90 returns ocrStatus=ocr_prefilled', async () => {
    const { svc } = makeService({
      extractVendorBill: vi.fn().mockResolvedValue({
        lineItems: [], confidence: 0.80, ocrStatus: 'manual', rawText: '',
      }),
    });
    const result = await svc.extractVendorBill(VALID_PDF_BUFFER, 'application/pdf');
    expect(result.ocrStatus).toBe('ocr_prefilled');
  });

  it('SC-4: confidence >= 0.90 returns ocrStatus=ocr_auto_filled', async () => {
    const { svc } = makeService({
      extractVendorBill: vi.fn().mockResolvedValue({
        lineItems: [], confidence: 0.95, ocrStatus: 'manual', rawText: '',
      }),
    });
    const result = await svc.extractVendorBill(VALID_PDF_BUFFER, 'application/pdf');
    expect(result.ocrStatus).toBe('ocr_auto_filled');
  });

  it('SC-4: returns OcrExtractionResult with confidence in [0,1]', async () => {
    const { svc } = makeService({
      extractVendorBill: vi.fn().mockResolvedValue({
        lineItems: [], confidence: 0.65, ocrStatus: 'manual', rawText: '[stub]',
      }),
    });
    const result = await svc.extractVendorBill(VALID_PDF_BUFFER, 'application/pdf');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.lineItems)).toBe(true);
  });

  it('SC-4: NEVER auto-posts a PurchaseBill — extractVendorBill returns extraction only', async () => {
    // OcrService must only return OcrExtractionResult; it has no reference to
    // PurchaseBillService. Verify the service has no postBill / createDraft method.
    const { svc } = makeService();
    expect(typeof (svc as any).postBill).toBe('undefined');
    expect(typeof (svc as any).purchaseBillService).toBe('undefined');
  });
});
