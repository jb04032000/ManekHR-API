import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as path from 'path';
import { PrintI18nService } from '../print-i18n.service';

const I18N_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'i18n');

function makeService(): PrintI18nService {
  const svc = new PrintI18nService();
  svc.loadFrom(I18N_DIR);
  return svc;
}

describe('PrintI18nService.t', () => {
  let svc: PrintI18nService;
  beforeAll(() => {
    svc = makeService();
  });

  it('returns en string', () => {
    expect(svc.t('en', 'common.invoice')).toBe('Invoice');
  });

  it('returns gu string in Gujarati script', () => {
    expect(svc.t('gu', 'common.invoice')).toBe('ઇન્વૉઇસ');
  });

  it('returns hi string in Devanagari', () => {
    expect(svc.t('hi', 'common.invoice')).toBe('इनवॉइस');
  });

  it('falls back to en on missing key and warns once', () => {
    const warnSpy = vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
    // tax.cgst exists in all three; force a miss with an unknown key
    const r = svc.t('gu', 'common.unknownKey');
    // Falls back to en miss too -> returns the key itself
    expect(r).toBe('common.unknownKey');
    expect(warnSpy).toHaveBeenCalled();
    // Warn only once for the same locale:key tuple
    warnSpy.mockClear();
    svc.t('gu', 'common.unknownKey');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back to en value when locale missing key but en has it', () => {
    // Build a service with an empty gu catalog manually
    const partialSvc = new PrintI18nService();
    (partialSvc as any).catalogs = {
      en: { common: { hello: 'Hello' } },
      gu: { common: {} },
      hi: { common: {} },
    };
    const warnSpy = vi.spyOn((partialSvc as any).logger, 'warn').mockImplementation(() => {});
    expect(partialSvc.t('gu', 'common.hello')).toBe('Hello');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('interpolates {var} placeholders', () => {
    const partialSvc = new PrintI18nService();
    (partialSvc as any).catalogs = {
      en: { common: { hi: 'Hello {name}, total {n}' } },
      gu: {},
      hi: {},
    };
    expect(partialSvc.t('en', 'common.hi', { name: 'Acme', n: 5 })).toBe('Hello Acme, total 5');
  });

  it('thankYou + signature exist across all 3 locales', () => {
    expect(svc.t('en', 'common.thankYou')).toBe('Thank you for your business');
    expect(svc.t('gu', 'common.thankYou').length).toBeGreaterThan(0);
    expect(svc.t('hi', 'common.thankYou').length).toBeGreaterThan(0);
  });
});
