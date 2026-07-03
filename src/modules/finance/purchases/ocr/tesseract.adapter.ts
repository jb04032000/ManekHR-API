import { Injectable, BadRequestException } from '@nestjs/common';
import { OcrAdapter, OcrExtractionResult } from './ocr-adapter.interface';

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Tesseract OCR adapter — local fallback when Google Document AI is not configured.
 *
 * Security (T-F04-02-05):
 *   - Validates mimeType against allowlist before processing
 *   - Rejects files > 10MB
 *   - Never executes file content; read-only text extraction
 *
 * Note: Full tesseract.js integration is deferred.
 * Returns confidence=0 (forces manual entry) as a safe stub.
 * To enable: install tesseract.js and implement the extraction logic.
 */
@Injectable()
export class TesseractOcrAdapter implements OcrAdapter {
  readonly providerName = 'tesseract';

  async extractVendorBill(fileBuffer: Buffer, mimeType: string): Promise<OcrExtractionResult> {
    // T-F04-02-05: validate mimeType against allowlist
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Unsupported mimeType: '${mimeType}'. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    // T-F04-02-05: reject oversized files
    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File size ${fileBuffer.length} bytes exceeds 10MB limit`,
      );
    }

    // Stub: returns low-confidence empty extraction so UI forces full manual entry.
    // TODO: install tesseract.js and wire createWorker() here when backend dependency is approved.
    return {
      lineItems: [],
      confidence: 0,
      ocrStatus: 'manual',
      rawText: '[Tesseract adapter stub — install tesseract.js and implement extractVendorBill to enable]',
    };
  }
}
