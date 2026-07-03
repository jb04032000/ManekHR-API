import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type PrintLocale = 'en' | 'gu' | 'hi';

type Catalog = Record<string, Record<string, string>>;

/**
 * PrintI18nService — loads en/gu/hi print catalogs at boot.
 * Per Phase 16 D-32 / D-33. t(locale, key, vars?) returns localized string;
 * missing key falls back to en and logs warn-once.
 */
@Injectable()
export class PrintI18nService implements OnModuleInit {
  private readonly logger = new Logger(PrintI18nService.name);
  private catalogs: Record<PrintLocale, Catalog> = { en: {}, gu: {}, hi: {} };
  private warnedKeys = new Set<string>();

  onModuleInit(): void {
    // src/modules/finance/sales/print-i18n -> src/i18n  (../../../../i18n)
    const base = path.join(__dirname, '..', '..', '..', '..', 'i18n');
    for (const loc of ['en', 'gu', 'hi'] as const) {
      try {
        const file = path.join(base, loc, 'print.json');
        const raw = fs.readFileSync(file, 'utf8');
        this.catalogs[loc] = JSON.parse(raw) as Catalog;
      } catch (e) {
        this.logger.error(`Failed to load i18n catalog for ${loc}`, e as Error);
        this.catalogs[loc] = {};
      }
    }
    this.logger.log(
      `Loaded print catalogs (en/gu/hi). Namespaces: ` +
        Object.keys(this.catalogs.en).join(','),
    );
  }

  /**
   * Look up `key` (dot-namespaced, e.g. "common.invoice") in `locale`.
   * Falls back to en on miss + warn-once. Supports `{var}` interpolation.
   */
  t(locale: PrintLocale, key: string, vars?: Record<string, string | number>): string {
    const dot = key.indexOf('.');
    const ns = dot >= 0 ? key.slice(0, dot) : key;
    const k = dot >= 0 ? key.slice(dot + 1) : '';
    let v: string | undefined = this.catalogs[locale]?.[ns]?.[k];
    if (v == null) {
      const warnKey = `${locale}:${key}`;
      if (!this.warnedKeys.has(warnKey)) {
        this.warnedKeys.add(warnKey);
        this.logger.warn(`Missing i18n key ${warnKey} — falling back to en`);
      }
      v = this.catalogs.en?.[ns]?.[k];
      if (v == null) return key;
    }
    if (vars) {
      v = String(v).replace(/\{(\w+)\}/g, (_, name) =>
        vars[name] != null ? String(vars[name]) : '',
      );
    }
    return v;
  }

  /** Test helper: load catalogs from explicit dir. */
  loadFrom(dir: string): void {
    for (const loc of ['en', 'gu', 'hi'] as const) {
      const file = path.join(dir, loc, 'print.json');
      this.catalogs[loc] = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
    }
  }
}
