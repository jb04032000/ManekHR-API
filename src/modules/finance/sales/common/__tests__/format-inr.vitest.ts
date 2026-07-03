import { describe, it, expect } from 'vitest';
import { formatINR } from '../format-inr.util';

describe('formatINR', () => {
  // 12_345_678 paise = 1,23,456.78 INR
  it('en: ₹1,23,456.78', () => {
    const out = formatINR(12_345_678, 'en');
    expect(out).toMatch(/₹/);
    expect(out).toMatch(/1,23,456\.78/);
  });

  it('gu: contains ₹ + Indian-grouped digits', () => {
    const out = formatINR(12_345_678, 'gu');
    expect(out).toMatch(/₹/);
    expect(out).toMatch(/1,23,456\.78/);
  });

  it('hi: contains ₹ + Indian-grouped digits', () => {
    const out = formatINR(12_345_678, 'hi');
    expect(out).toMatch(/₹/);
    expect(out).toMatch(/1,23,456\.78/);
  });

  it('en: 10 lakh formats as ₹10,00,000.00', () => {
    expect(formatINR(100_000_000, 'en')).toMatch(/₹\s*10,00,000\.00/);
  });

  it('1 paisa (paise=1) formats as ₹0.01', () => {
    expect(formatINR(1, 'en')).toMatch(/0\.01/);
  });

  it('0 paise -> ₹0.00', () => {
    expect(formatINR(0, 'en')).toMatch(/₹\s*0\.00/);
  });

  it('1 crore = 1,00,00,000.00', () => {
    expect(formatINR(10_000_000_00, 'en')).toMatch(/1,00,00,000\.00/);
  });
});
