import { describe, it, expect } from 'vitest';
import { resolveLocale } from '../locale-resolver';

describe('resolveLocale', () => {
  it('explicit wins over party + firm', () => {
    expect(
      resolveLocale({
        explicit: 'hi',
        party: { preferredLocale: 'gu' },
        firm: { defaultPrintLocale: 'en' },
      }),
    ).toBe('hi');
  });

  it('party wins over firm when explicit absent', () => {
    expect(
      resolveLocale({
        party: { preferredLocale: 'gu' },
        firm: { defaultPrintLocale: 'en' },
      }),
    ).toBe('gu');
  });

  it('firm only when nothing else', () => {
    expect(resolveLocale({ firm: { defaultPrintLocale: 'hi' } })).toBe('hi');
  });

  it('defaults to en when nothing set', () => {
    expect(resolveLocale({})).toBe('en');
  });

  it('invalid explicit falls through to party', () => {
    expect(
      resolveLocale({
        explicit: 'zz',
        party: { preferredLocale: 'gu' },
      }),
    ).toBe('gu');
  });

  it('invalid party + firm both fall through to en', () => {
    expect(
      resolveLocale({
        party: { preferredLocale: 'klingon' },
        firm: { defaultPrintLocale: 'martian' },
      }),
    ).toBe('en');
  });

  it('null/undefined party object handled', () => {
    expect(resolveLocale({ party: null, firm: { defaultPrintLocale: 'gu' } })).toBe('gu');
  });
});
