import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Catalog completeness — every key in en/print.json must exist in gu/print.json
 * and hi/print.json. This test FAILS THE BUILD if a translation is missing.
 *
 * Per Phase 16 D-32 / D-33 / threat T-16-05-01.
 */

type AnyObj = Record<string, any>;

function collectKeys(obj: AnyObj, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectKeys(v as AnyObj, next));
    } else {
      out.push(next);
    }
  }
  return out;
}

function getDeep(obj: AnyObj, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, p) => {
    if (acc && typeof acc === 'object') return (acc as AnyObj)[p];
    return undefined;
  }, obj);
}

const I18N_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'i18n');

describe('print i18n catalog completeness', () => {
  const en = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'en', 'print.json'), 'utf8'));
  const gu = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'gu', 'print.json'), 'utf8'));
  const hi = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'hi', 'print.json'), 'utf8'));

  const enKeys = collectKeys(en);

  it('en catalog has at least common, sales, tax, numbers namespaces', () => {
    expect(Object.keys(en)).toEqual(
      expect.arrayContaining(['common', 'sales', 'tax', 'numbers', 'terms']),
    );
    expect(enKeys.length).toBeGreaterThan(20);
  });

  it('every en key exists in gu', () => {
    const missing = enKeys.filter((k) => getDeep(gu, k) == null);
    expect(missing, `Missing in gu:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every en key exists in hi', () => {
    const missing = enKeys.filter((k) => getDeep(hi, k) == null);
    expect(missing, `Missing in hi:\n${missing.join('\n')}`).toEqual([]);
  });
});
