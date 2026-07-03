/**
 * formatINR(paise, locale) — Indian-currency formatter using Intl.NumberFormat
 * with en-IN / gu-IN / hi-IN locales. Per D-36 the lakh/crore separator pattern
 * (1,23,456.78) and ₹ symbol are used in all three locales. Latin digits only
 * (D-35).
 */
export type SupportedFormatLocale = 'en' | 'gu' | 'hi';

export function formatINR(paise: number, locale: SupportedFormatLocale = 'en'): string {
  if (!Number.isFinite(paise)) return '';
  const intlLocale =
    locale === 'gu' ? 'gu-IN' : locale === 'hi' ? 'hi-IN' : 'en-IN';
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
