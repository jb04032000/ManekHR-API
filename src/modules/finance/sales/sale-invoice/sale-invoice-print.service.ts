import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';

/**
 * SaleInvoicePrintService
 *
 * Generates a PDF buffer for a SaleInvoice.
 *
 * When `invoice.eInvoice.status === 'generated'` and `invoice.eInvoice.signedQrCode`
 * is present, the signed QR code (NIC IRP signed payload string) is rendered as a
 * 25mm × 25mm QR image in the top-right corner of the first page.
 *
 * The QR image is generated server-side using the `qrcode` npm package, which
 * produces a base64 PNG data URL that PDFKit can accept as a Buffer via image().
 *
 * F-12-SC-03 requirement: "IRN and signed QR stored AND printed on invoice".
 *
 * Wave 9 note: This service ships the QR integration. The full themed invoice
 * layout (company logo, letterhead, line-item table) is deferred to Wave 9
 * which replaces the basic layout with jsPDF + autotable themed output.
 * Until Wave 9, the PDF contains essential fields + QR.
 *
 * @see PrintService (zari360-backend/src/modules/finance/sales/print/print.service.ts)
 *   for the minimal Wave-5 stub that this service extends.
 */
@Injectable()
export class SaleInvoicePrintService {
  private readonly logger = new Logger(SaleInvoicePrintService.name);

  /**
   * Generates a PDF buffer for a SaleInvoice.
   *
   * Renders:
   *  - Invoice header (firm name, GST No, invoice number, date, party)
   *  - IRN + Ack No + Ack Date when e-Invoice is generated
   *  - Signed QR code image (25mm × 25mm) in top-right when signedQrCode present
   *  - Grand total
   *
   * @param invoice  Mongoose document or plain object with SaleInvoice fields
   * @returns        Promise<Buffer> — PDF bytes
   */
  async generatePdfBuffer(invoice: any): Promise<Buffer> {
    this.logger.log(
      `generatePdfBuffer: voucherNumber=${invoice?.voucherNumber ?? '(draft)'} ` +
        `eInvoice.status=${invoice?.eInvoice?.status ?? 'none'}`,
    );

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // ── Page dimensions ────────────────────────────────────────────────────────
    const pageWidth = doc.page.width;  // ~595 pt (A4)
    const pageHeight = doc.page.height; // ~842 pt (A4)
    void pageHeight;

    // ── Signed QR image (top-right corner) ────────────────────────────────────
    const ei = invoice?.eInvoice;
    if (ei?.status === 'generated' && ei?.signedQrCode) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const QRCode = require('qrcode');

        // QRCode.toDataURL returns "data:image/png;base64,..."
        const qrDataUrl: string = await QRCode.toDataURL(ei.signedQrCode, {
          errorCorrectionLevel: 'M',
          type: 'image/png',
          width: 200, // px — rendered at 200px; pdfkit scales to mm spec below
        });

        // Strip data URL prefix → raw base64 → Buffer
        const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
        const qrBuffer = Buffer.from(base64, 'base64');

        // Place QR at top-right: 71pt × 71pt ≈ 25mm × 25mm in A4 (1mm ≈ 2.835pt)
        const QR_SIZE_PT = 71; // 25mm
        const QR_MARGIN_PT = 14; // 5mm from right/top edge
        const qrX = pageWidth - QR_SIZE_PT - QR_MARGIN_PT;
        const qrY = QR_MARGIN_PT;

        doc.image(qrBuffer, qrX, qrY, { width: QR_SIZE_PT, height: QR_SIZE_PT });

        // IRN + Ack details below QR (small font)
        if (ei.irn) {
          doc
            .font('Courier')
            .fontSize(6)
            .fillColor('#555555')
            .text(`IRN: ${(ei.irn as string).slice(0, 16)}...`, qrX, qrY + QR_SIZE_PT + 3, {
              width: QR_SIZE_PT + 20,
              align: 'left',
            });
        }
        if (ei.ackNo) {
          doc.text(`Ack: ${ei.ackNo}`, qrX, qrY + QR_SIZE_PT + 10, {
            width: QR_SIZE_PT + 20,
            align: 'left',
          });
        }

        // Reset font
        doc.font('Helvetica').fillColor('#000000');
      } catch (err: any) {
        this.logger.warn(
          `Failed to render QR code for invoice ${invoice?.voucherNumber}: ${err.message}`,
        );
        // Continue without QR — non-fatal
      }
    }

    // ── Invoice header ─────────────────────────────────────────────────────────
    const firmName: string = invoice?.firmSnapshot?.firmName ?? invoice?.firm?.firmName ?? '';
    const gstin: string = invoice?.firmSnapshot?.gstin ?? invoice?.firm?.gstin ?? '';
    const voucherNumber: string = invoice?.voucherNumber ?? '(Draft)';
    const voucherDate: string = invoice?.voucherDate
      ? new Date(invoice.voucherDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    const partyName: string = invoice?.partySnapshot?.name ?? '';
    const grandTotal: number = (invoice?.grandTotalPaise ?? 0) / 100;

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('#1a1a1a')
      .text(firmName || 'Invoice', 40, 40, { width: pageWidth - 200 });

    if (gstin) {
      doc.font('Helvetica').fontSize(10).fillColor('#555555').text(`GSTIN: ${gstin}`, 40, 62);
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#1a1a1a')
      .text(`TAX INVOICE`, 40, 90);

    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#333333')
      .text(`Invoice No: ${voucherNumber}`, 40, 110)
      .text(`Date: ${voucherDate}`, 40, 126);

    if (partyName) {
      doc.text(`Bill To: ${partyName}`, 40, 142);
    }

    // ── e-Invoice fields ───────────────────────────────────────────────────────
    if (ei?.status === 'generated' && ei?.irn) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#1a1a1a')
        .text('e-Invoice Details', 40, 175);

      doc
        .font('Courier')
        .fontSize(8)
        .fillColor('#555555')
        .text(`IRN: ${ei.irn}`, 40, 190, { width: pageWidth - 160, lineBreak: true })
        .text(`Ack No: ${ei.ackNo ?? ''}`, 40, 210)
        .text(`Ack Date: ${ei.ackDate ? new Date(ei.ackDate).toLocaleString('en-IN') : ''}`, 40, 222);
    }

    // ── Grand total ────────────────────────────────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#1a1a1a')
      .text(
        `Grand Total: ₹${grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        40,
        260,
      );

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#aaaaaa')
      .text('Generated by ManekHR Finance', 40, doc.page.height - 40, {
        align: 'center',
        width: pageWidth - 80,
      });

    doc.end();

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
