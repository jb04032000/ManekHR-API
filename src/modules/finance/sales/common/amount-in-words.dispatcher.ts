import { amountInWords as amountInWordsEn } from './amount-in-words.util';
import { amountInWordsGu } from './amount-in-words-gu.util';
import { amountInWordsHi } from './amount-in-words-hi.util';

export type AmountWordsLocale = 'en' | 'gu' | 'hi';

/**
 * Dispatch amount-in-words helper by locale (D-40).
 * paise (integer) -> localized words string.
 */
export function amountInWords(paise: number, locale: AmountWordsLocale = 'en'): string {
  switch (locale) {
    case 'gu':
      return amountInWordsGu(paise);
    case 'hi':
      return amountInWordsHi(paise);
    default:
      return amountInWordsEn(paise);
  }
}
