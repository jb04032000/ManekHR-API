import { Module } from '@nestjs/common';
import { env } from '../../../../config/env';
import { OcrService } from './ocr.service';
import { OcrController } from './ocr.controller';
import { TesseractOcrAdapter } from './tesseract.adapter';
import { GoogleDocumentAiAdapter } from './google-document-ai.adapter';

/**
 * OcrModule — provides OCR extraction for vendor bills.
 *
 * GoogleDocumentAiAdapter is registered as an optional provider:
 * - When GOOGLE_DOCUMENT_AI_PROCESSOR_ID is set, both adapters are provided
 *   and OcrService can be configured to use Google Document AI.
 * - When the env var is absent, only TesseractOcrAdapter is used
 *   (confidence=0 stub → forces manual entry, which is the safe default).
 *
 * NOTE: GoogleDocumentAiAdapter constructor throws when the env var is absent.
 * To avoid crashing the app, we conditionally include it via a useFactory provider.
 */
const googleDocumentAiProvider = {
  provide: GoogleDocumentAiAdapter,
  useFactory: () => {
    if (env.googleDocumentAi.processorId) {
      return new GoogleDocumentAiAdapter();
    }
    return null;
  },
};

@Module({
  controllers: [OcrController],
  providers: [TesseractOcrAdapter, googleDocumentAiProvider, OcrService],
  exports: [OcrService],
})
export class OcrModule {}
