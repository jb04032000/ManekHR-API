import { registerAs } from '@nestjs/config';
import { env } from './env';

/**
 * Brand asset URLs consumed by:
 *   - mail.service.ts          (Handlebars template `{{brand.*}}` context)
 *   - marketing.service.ts     (wrapEmail header image)
 *   - invoice-pdf.service.ts   (PDF header band)
 *   - payslip-pdf.service.ts   (header logo + watermark)
 *
 * Each URL must be absolutely qualified — Gmail/Outlook strip relative paths.
 * Defaults compose `${R2_PUBLIC_URL}/brand/<filename>` so a single env var
 * (R2_PUBLIC_URL) drives all of them. Override individually only if a CDN
 * subpath differs.
 */
export default registerAs('branding', () => {
  const r2Base = env.branding.r2PublicUrl.replace(/\/$/, '');
  const brandBase = r2Base ? `${r2Base}/brand` : '';

  const compose = (filename: string, override?: string) =>
    override && override.trim() !== '' ? override : brandBase ? `${brandBase}/${filename}` : '';

  return {
    /** Top of every transactional + marketing email (Card 12). 600x200. */
    emailHeader: compose('email-header.png', env.branding.emailHeaderUrl),
    /** Email signature image fallback (Card 13). 520x160. FLAGGED for `.in` re-export. */
    emailSignature: compose('email-signature.png', env.branding.emailSignatureUrl),
    /** Top band of invoice / receipt PDFs (Card 14). 2480x600. FLAGGED. */
    invoiceHeader: compose('invoice-header.png', env.branding.invoiceHeaderUrl),
    /** Payslip PDF watermark (Card 15). 800x800, 20% opacity baked in. */
    watermark: compose('watermark.png', env.branding.watermarkUrl),
    /** A4 letterhead background (Card 16). 2480x3508. FLAGGED. */
    letterhead: compose('letterhead-a4.png', env.branding.letterheadUrl),
    /** Inline tagline lockup (Card 09). 1200x600. */
    taglineInline: compose('tagline-lockup-inline.png', env.branding.taglineInlineUrl),
    /** Stacked tagline lockup (Card 10). 800x600. */
    taglineStacked: compose('tagline-lockup-stacked.png', env.branding.taglineStackedUrl),
    /** Editorial tagline lockup (Card 10b). 1200x600. */
    taglineEditorial: compose('tagline-lockup-editorial.png', env.branding.taglineEditorialUrl),
  };
});
