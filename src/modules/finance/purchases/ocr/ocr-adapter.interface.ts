export interface OcrLineItem {
  description?: string;
  qty?: number;
  unit?: string;
  ratePaise?: number;
  taxRate?: number;
  lineTotalPaise?: number;
  confidence: number;
}

export interface OcrExtractionResult {
  vendorName?: string;
  vendorGstin?: string;
  invoiceNumber?: string;
  invoiceDate?: string;        // ISO date string
  totalAmountPaise?: number;
  taxableValuePaise?: number;
  gstAmountPaise?: number;
  lineItems: OcrLineItem[];
  /** Overall confidence in [0, 1]. < 0.70 forces manual review. */
  confidence: number;
  rawText?: string;
  /**
   * manual         — confidence < 0.70; UI forces full manual entry
   * ocr_prefilled  — confidence 0.70–0.89; UI shows pre-filled fields for review
   * ocr_auto_filled — confidence >= 0.90; UI can auto-fill (user still reviews)
   *
   * OcrService NEVER auto-posts a PurchaseBill — always returns extraction only.
   */
  ocrStatus: 'manual' | 'ocr_prefilled' | 'ocr_auto_filled';
}

/**
 * Provider-agnostic OCR adapter interface.
 * All providers must implement extractVendorBill and expose providerName.
 */
export interface OcrAdapter {
  readonly providerName: string;
  extractVendorBill(fileBuffer: Buffer, mimeType: string): Promise<OcrExtractionResult>;
}
