import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Heuristic guard against English string literals leaking into theme files.
 * A "hardcoded English phrase" is two consecutive Title-Cased / lowercase
 * English words inside a string literal — these would survive locale
 * switches and break the i18n contract.
 *
 * The regex deliberately excludes: import paths (skipped at line level),
 * comments (skipped at line level), single words, identifiers with dots
 * (e.g. 'common.invoice'), and code expressions.
 */

const THEMES_DIR = path.resolve(__dirname, '..', 'themes');

describe('theme files have no hardcoded English phrases', () => {
  const files = ['theme-classic.ts', 'theme-modern.ts'];
  // Two consecutive words separated by a space, both starting with letters.
  // Anchored on opening quote to avoid matching descriptive text in identifiers.
  const phraseRegex = /["'`]([A-Z][a-z]+\s+[A-Za-z][a-z]+[^"'`]*)["'`]/;

  for (const f of files) {
    it(`${f} contains only t() lookups + identifiers`, () => {
      const fullPath = path.join(THEMES_DIR, f);
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
      const offenders: string[] = [];
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (trimmed.startsWith('import ')) return;
        const m = phraseRegex.exec(line);
        if (m) offenders.push(`${f}:${i + 1}  ${m[1]}`);
      });
      expect(
        offenders,
        `Hardcoded English phrases:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});
