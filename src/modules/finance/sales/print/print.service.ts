import { Injectable, Logger, Optional } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsPDFCtor: any = require('jspdf').default ?? require('jspdf').jsPDF ?? require('jspdf');

import * as Fonts from './fonts';
import { ThemeRegistry } from './themes';
// Side-effect import: registers Classic + Modern with ThemeRegistry.
import './themes';
import { PrintI18nService, type PrintLocale } from '../print-i18n/print-i18n.service';
import { resolveLocale } from '../print-i18n/locale-resolver';
import { formatINR } from '../common/format-inr.util';
import { amountInWords } from '../common/amount-in-words.dispatcher';

export interface RenderInvoiceOptions {
  locale?: PrintLocale;
  themeId?: string;
}

/**
 * PrintService — production renderer (Phase 16 Plan 05).
 *
 * Replaces the Wave-5 stub. renderInvoicePdf(invoice, party, firm, opts) returns
 * a Buffer of valid PDF, with embedded Noto fonts per locale and theme dispatch
 * via ThemeRegistry. The legacy generatePdfBuffer(voucher) signature is preserved
 * for callers that still rely on it (sale-invoice email send path).
 */
@Injectable()
export class PrintService {
  private readonly logger = new Logger(PrintService.name);

  constructor(@Optional() private readonly i18n?: PrintI18nService) {}

  /**
   * Install Latin + Gujarati + Devanagari Noto fonts into a jsPDF instance.
   * Returns true on success, false on any font-load failure (caller falls
   * back to helvetica).
   */
  private installFonts(pdf: any): boolean {
    try {
      pdf.addFileToVFS('NotoSans-Regular.ttf', Fonts.NOTO_SANS_REGULAR);
      pdf.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
      pdf.addFileToVFS('NotoSans-Bold.ttf', Fonts.NOTO_SANS_BOLD);
      pdf.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');
      pdf.addFileToVFS('NotoSansGujarati-Regular.ttf', Fonts.NOTO_SANS_GUJARATI_REGULAR);
      pdf.addFont('NotoSansGujarati-Regular.ttf', 'NotoSansGujarati', 'normal');
      pdf.addFileToVFS('NotoSansGujarati-Bold.ttf', Fonts.NOTO_SANS_GUJARATI_BOLD);
      pdf.addFont('NotoSansGujarati-Bold.ttf', 'NotoSansGujarati', 'bold');
      pdf.addFileToVFS('NotoSansDevanagari-Regular.ttf', Fonts.NOTO_SANS_DEVANAGARI_REGULAR);
      pdf.addFont('NotoSansDevanagari-Regular.ttf', 'NotoSansDevanagari', 'normal');
      pdf.addFileToVFS('NotoSansDevanagari-Bold.ttf', Fonts.NOTO_SANS_DEVANAGARI_BOLD);
      pdf.addFont('NotoSansDevanagari-Bold.ttf', 'NotoSansDevanagari', 'bold');
      return true;
    } catch (e) {
      this.logger.error('Font install failed; falling back to helvetica', e as Error);
      return false;
    }
  }

  private fontFamilyFor(locale: PrintLocale): string {
    return locale === 'gu'
      ? 'NotoSansGujarati'
      : locale === 'hi'
        ? 'NotoSansDevanagari'
        : 'NotoSans';
  }

  /**
   * Render a Sale Invoice (or compatible voucher) to PDF in the requested
   * locale and theme. Locale resolution per D-37; theme resolution defaults
   * to firm.defaultThemeId then 'classic'.
   */
  async renderInvoicePdf(
    invoice: any,
    party: any,
    firm: any,
    opts: RenderInvoiceOptions = {},
  ): Promise<Buffer> {
    const locale = resolveLocale({ explicit: opts.locale, party, firm });
    const themeId = opts.themeId ?? firm?.defaultThemeId ?? 'classic';

    const pdf = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    let fontFamily: string;
    if (this.installFonts(pdf)) {
      fontFamily = this.fontFamilyFor(locale);
      try {
        pdf.setFont(fontFamily, 'normal');
      } catch {
        fontFamily = 'helvetica';
        pdf.setFont(fontFamily, 'normal');
      }
    } else {
      fontFamily = 'helvetica';
      pdf.setFont(fontFamily, 'normal');
    }

    const t = (key: string, vars?: Record<string, string | number>) =>
      this.i18n ? this.i18n.t(locale, key, vars) : key;

    const theme = ThemeRegistry.has(themeId)
      ? ThemeRegistry.get(themeId)
      : ThemeRegistry.get('classic');

    // Pre-generate IRP QR base64 when e-Invoice is present (CGST Rule 48).
    // Done here (async, before render) because theme.render() is synchronous.
    let irpQrBase64: string | undefined;
    const ei = invoice?.eInvoice;
    if (ei?.irn && ei?.signedQrCode) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const QRCode = require('qrcode');
        irpQrBase64 = await QRCode.toDataURL(ei.signedQrCode as string, {
          errorCorrectionLevel: 'M',
          type: 'image/png',
          width: 200,
        });
      } catch (e) {
        this.logger.warn(
          `IRP QR pre-generation failed for invoice ${invoice?.voucherNumber}: ${(e as Error).message}`,
        );
        // Non-fatal: continue without QR
      }
    }

    theme.render({
      pdf,
      locale,
      t,
      fontFamily,
      invoice,
      party,
      firm,
      formatINR: (px: number) => formatINR(px, locale),
      amountInWords: (px: number) => amountInWords(px, locale),
      irpQrBase64,
    });

    const arr = pdf.output('arraybuffer');
    return Buffer.from(arr);
  }

  /**
   * Legacy entry point preserved for the Wave-5 sale-invoice email-send path.
   * Delegates to renderInvoicePdf when the voucher has the expected shape;
   * falls back to a minimal placeholder PDF on missing data.
   */
  async generatePdfBuffer(voucher: any, template = 'classic', firmOverride?: any): Promise<Buffer> {
    if (voucher && typeof voucher === 'object' && (voucher.lineItems || voucher.totalPaise)) {
      const party = voucher.partySnapshot ?? {};
      // firmOverride lets callers that have loaded the live firm (e.g. the email
      // send path) pass through per-firm config such as invoiceLayout, which the
      // stored voucher does not carry as a snapshot.
      const firm = firmOverride ?? voucher.firmSnapshot ?? {};
      return this.renderInvoicePdf(voucher, party, firm, { themeId: template });
    }
    // Minimal placeholder when called with a non-invoice payload.
    const pdf = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    pdf.setFontSize(11);
    pdf.text(`Voucher: ${voucher?.voucherNumber ?? '(draft)'}`, 14, 20);
    return Buffer.from(pdf.output('arraybuffer'));
  }
}
