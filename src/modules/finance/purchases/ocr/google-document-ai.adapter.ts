import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { env } from '../../../../config/env';
import { OcrAdapter, OcrExtractionResult } from './ocr-adapter.interface';

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Google Document AI OCR adapter.
 *
 * Activated when GOOGLE_DOCUMENT_AI_PROCESSOR_ID env var is set.
 * The processor ID identifies the Document AI processor resource to call.
 *
 * Security (T-F04-02-05):
 *   - Validates mimeType before sending to Google
 *   - Rejects files > 10MB
 *
 * Note: Full Google Document AI API integration is deferred (requires
 * @google-cloud/documentai package and service account credentials).
 * Returns confidence=0 stub for now; wire real API in F-04-03.
 */
@Injectable()
export class GoogleDocumentAiAdapter implements OcrAdapter {
  private readonly logger = new Logger(GoogleDocumentAiAdapter.name);
  readonly providerName = 'google_document_ai';

  constructor() {
    const processorId = env.googleDocumentAi.processorId;
    if (!processorId) {
      throw new Error(
        'GoogleDocumentAiAdapter: GOOGLE_DOCUMENT_AI_PROCESSOR_ID env var is not set. ' +
          'Use TesseractOcrAdapter as fallback when this variable is absent.',
      );
    }
    this.logger.log(`Google Document AI adapter initialised with processor: ${processorId}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async extractVendorBill(fileBuffer: Buffer, mimeType: string): Promise<OcrExtractionResult> {
    // Validate mimeType and file size (T-F04-02-05)
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Unsupported mimeType: '${mimeType}'. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }
    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(`File size ${fileBuffer.length} bytes exceeds 10MB limit`);
    }

    // TODO: implement real Google Document AI call in F-04-03
    // Stub returns confidence=0 to force manual review until real integration is wired.
    this.logger.warn(
      'GoogleDocumentAiAdapter.extractVendorBill: real API call not yet implemented (F-04-03)',
    );
    return {
      lineItems: [],
      confidence: 0,
      ocrStatus: 'manual',
      rawText: '[Google Document AI stub — implement API call in F-04-03]',
    };
  }
}
