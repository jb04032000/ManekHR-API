import { describe, it, expect } from 'vitest';
import { amountInWords } from '../amount-in-words.dispatcher';
import { amountInWordsGu } from '../amount-in-words-gu.util';
import { amountInWordsHi } from '../amount-in-words-hi.util';

/**
 * Table-driven amount-in-words tests across en/gu/hi.
 * Per Phase 16 D-40.
 *
 * The 'en' arm delegates to the existing F-02 helper which uses the
 * "Rupees X Only" word ordering — kept stable to avoid invalidating
 * existing snapshots persisted on SaleInvoice.amountInWords.
 */

describe('amountInWords dispatcher (en path = existing util)', () => {
  it('0 paise', () => {
    expect(amountInWords(0, 'en')).toBe('Rupees Zero Only');
  });

  it('100 paise = 1 rupee', () => {
    expect(amountInWords(100, 'en')).toBe('Rupees One Only');
  });

  it('1 crore = 100,00,00,000 paise', () => {
    expect(amountInWords(1_000_000_000_0, 'en')).toBe('Rupees Ten Crore Only');
  });

  it('routes by locale arg', () => {
    expect(amountInWords(0, 'gu')).toContain('શૂન્ય');
    expect(amountInWords(0, 'hi')).toContain('शून्य');
  });
});

describe('amountInWordsGu (Gujarati)', () => {
  const cases: Array<[number, string]> = [
    [0, 'શૂન્ય રૂપિયા ફક્ત'],
    [100, 'એક રૂપિયો ફક્ત'],
    [1900, 'ઓગણીસ રૂપિયા ફક્ત'],
    [10_000, 'એક સો રૂપિયા ફક્ત'],
    [123_400, 'એક હજાર બે સો ચોત્રીસ રૂપિયા ફક્ત'],
    // 1 lakh in rupees = 10000000 paise
    [10_000_000, 'એક લાખ રૂપિયા ફક્ત'],
    // 1 crore in rupees = 1_000_000_000 paise
    [1_000_000_000, 'એક કરોડ રૂપિયા ફક્ત'],
  ];
  for (const [paise, expected] of cases) {
    it(`paise=${paise} -> ${expected}`, () => {
      expect(amountInWordsGu(paise)).toBe(expected);
    });
  }

  it('handles paise remainder', () => {
    // 1234567850 paise = 12,34,56,78.50 rupees-and-paise
    const out = amountInWordsGu(1_234_567_850);
    expect(out).toContain('પૈસા');
    expect(out).toContain('રૂપિયા');
    expect(out).toMatch(/ફક્ત$/);
  });

  it('paise-only when rupees=0', () => {
    expect(amountInWordsGu(50)).toBe('પચાસ પૈસા ફક્ત');
  });

  it('123456 rupees uses lakh', () => {
    // 123456 rupees = 12345600 paise
    const out = amountInWordsGu(12_345_600);
    expect(out).toContain('લાખ');
    expect(out).toContain('હજાર');
    expect(out).toMatch(/^એક લાખ /);
    expect(out).toMatch(/ રૂપિયા ફક્ત$/);
  });
});

describe('amountInWordsHi (Hindi)', () => {
  const cases: Array<[number, string]> = [
    [0, 'शून्य रुपये केवल'],
    [100, 'एक रुपया केवल'],
    [1900, 'उन्नीस रुपये केवल'],
    [10_000, 'एक सौ रुपये केवल'],
    [10_000_000, 'एक लाख रुपये केवल'],
    [1_000_000_000, 'एक करोड़ रुपये केवल'],
  ];
  for (const [paise, expected] of cases) {
    it(`paise=${paise} -> ${expected}`, () => {
      expect(amountInWordsHi(paise)).toBe(expected);
    });
  }

  it('paise-only when rupees=0', () => {
    expect(amountInWordsHi(50)).toBe('पचास पैसे केवल');
  });

  it('123456 rupees uses lakh + hazaar', () => {
    const out = amountInWordsHi(12_345_600);
    expect(out).toContain('लाख');
    expect(out).toContain('हज़ार');
    expect(out).toMatch(/^एक लाख /);
    expect(out).toMatch(/ रुपये केवल$/);
  });
});
