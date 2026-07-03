import { Injectable } from '@nestjs/common';
import { OcrAdapter, OcrExtractionResult } from './ocr-adapter.interface';
import { TesseractOcrAdapter } from './tesseract.adapter';

/**
 * OcrService — provider-agnostic OCR facade.
 *
 * Adapter selection:
 *   - Default: TesseractOcrAdapter (always available; low-confidence stub)
 *   - Google Document AI: wired via env-driven module provider in F-04-03
 *     (inject GoogleDocumentAiAdapter when GOOGLE_DOCUMENT_AI_PROCESSOR_ID is set)
 *
 * CRITICAL (T-F04-02-09): OcrService NEVER auto-posts a PurchaseBill.
 *   extractVendorBill always returns OcrExtractionResult ONLY.
 *   UI must explicitly create draft + call PurchaseBillService.post() separately.
 *
 * Confidence routing:
 *   < 0.70  → ocrStatus='manual'          (user must fill all fields)
 *   0.70–0.89 → ocrStatus='ocr_prefilled' (user reviews pre-filled fields)
 *   >= 0.90 → ocrStatus='ocr_auto_filled' (user confirms and posts)
 */
@Injectable()
export class OcrService {
  private readonly adapter: OcrAdapter;

  constructor(private readonly tesseract: TesseractOcrAdapter) {
    // Default to tesseract; F-04-03 will inject Google Document AI when configured
    this.adapter = tesseract;
  }

  async extractVendorBill(fileBuffer: Buffer, mimeType: string): Promise<OcrExtractionResult> {
    const result = await this.adapter.extractVendorBill(fileBuffer, mimeType);

    // Confidence-based ocrStatus routing (applied after adapter extraction)
    if (result.confidence < 0.70) {
      result.ocrStatus = 'manual';
    } else if (result.confidence < 0.90) {
      result.ocrStatus = 'ocr_prefilled';
    } else {
      result.ocrStatus = 'ocr_auto_filled';
    }

    return result;
  }
}
