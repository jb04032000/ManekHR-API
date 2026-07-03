/**
 * Phase 16 — Multi-language voucher PDF fonts.
 *
 * Per D-32 / D-33 / D-34: voucher PDFs render in `en`, `gu`, or `hi`
 * via embedded Noto fonts. jsPDF consumes these base64 TTF strings via
 * `addFileToVFS` + `addFont`.
 *
 * Coverage strategy (D-35):
 * - NOTO_SANS_*           — Latin glyphs, punctuation, ₹ (U+20B9), digits 0-9.
 * - NOTO_SANS_GUJARATI_*  — Gujarati script glyphs (U+0A80..U+0AFF) + ₹.
 *                            Latin digits NOT included; Latin Noto Sans must
 *                            be layered for numeric rendering.
 * - NOTO_SANS_DEVANAGARI_* — Devanagari script glyphs (U+0900..U+097F) + ₹
 *                            + Latin digits 0-9.
 *
 * License: SIL Open Font License v1.1 (compatible with project license).
 */
export { NOTO_SANS_REGULAR } from './noto-sans-regular';
export { NOTO_SANS_BOLD } from './noto-sans-bold';
export { NOTO_SANS_GUJARATI_REGULAR } from './noto-sans-gujarati-regular';
export { NOTO_SANS_GUJARATI_BOLD } from './noto-sans-gujarati-bold';
export { NOTO_SANS_DEVANAGARI_REGULAR } from './noto-sans-devanagari-regular';
export { NOTO_SANS_DEVANAGARI_BOLD } from './noto-sans-devanagari-bold';

/**
 * Per-locale primary font family names. The print service registers each
 * variant (Regular + Bold) into jsPDF's VFS under these family names so
 * `doc.setFont(FONT_FAMILY_BY_LOCALE[locale], 'normal' | 'bold')` works.
 *
 * For `gu` and `hi`, Latin Noto Sans must additionally be registered as a
 * fallback so digits and embedded English tokens render correctly.
 */
export const FONT_FAMILY_BY_LOCALE = {
  en: 'NotoSans',
  gu: 'NotoSansGujarati',
  hi: 'NotoSansDevanagari',
} as const;

export type PrintLocale = keyof typeof FONT_FAMILY_BY_LOCALE;
