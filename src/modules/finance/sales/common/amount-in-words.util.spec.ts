import { amountInWords } from './amount-in-words.util';

describe('amountInWords', () => {
  it('returns "Rupees Zero Only" for 0 paise', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });

  it('returns "Rupees One Only" for 100 paise (1.00 INR)', () => {
    expect(amountInWords(100)).toBe('Rupees One Only');
  });

  it('returns lakh-crore format for 12345678 paise', () => {
    expect(amountInWords(12345678)).toBe(
      'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only',
    );
  });

  it('returns "Rupees One Crore Only" for 1000000000 paise (1 crore INR = 1,00,00,000 rupees)', () => {
    expect(amountInWords(1000000000)).toBe('Rupees One Crore Only');
  });

  it('returns paise-only string when rupees == 0 and paise > 0', () => {
    expect(amountInWords(50)).toBe('Fifty Paise Only');
  });

  it('returns empty string for negative input', () => {
    expect(amountInWords(-100)).toBe('');
  });

  it('omits "and Zero Paise" clause when paise remainder is 0', () => {
    expect(amountInWords(5000000)).toBe('Rupees Fifty Thousand Only');
  });

  it('handles large rupee amounts correctly (12 lakh 34 thousand 500)', () => {
    expect(amountInWords(123450000)).toBe(
      'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Only',
    );
  });
});
