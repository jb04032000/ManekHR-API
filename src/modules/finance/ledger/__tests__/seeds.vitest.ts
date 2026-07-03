import { describe, it, expect } from 'vitest';
import { COA_SEED_MAP, commonComplianceSeeds, textileDelta, type CoaSeed } from '../seeds';

// Guards the CoA seed templates: no duplicate codes (the bug that bites when a
// shared code like 1012 means two different things), valid account types, and the
// textile + compliance ledgers the posting engine relies on are actually present.
// These arrays back AccountsService.seedFromTemplate and the inventory backfill.

const VALID_TYPES = new Set(['asset', 'liability', 'capital', 'income', 'expense']);

const codes = (seeds: CoaSeed[]) => seeds.map((s) => s.code);

describe('CoA seed templates', () => {
  it('exposes a template for every business type', () => {
    expect(Object.keys(COA_SEED_MAP).sort()).toEqual(
      ['composition', 'manufacturing', 'service', 'textile', 'trading'].sort(),
    );
  });

  for (const [businessType, seeds] of Object.entries(COA_SEED_MAP)) {
    describe(businessType, () => {
      it('has no duplicate account codes', () => {
        const seen = new Map<string, string>();
        const dups: string[] = [];
        for (const s of seeds) {
          if (seen.has(s.code)) {
            dups.push(`${s.code}: "${seen.get(s.code)}" vs "${s.name}"`);
          }
          seen.set(s.code, s.name);
        }
        expect(dups).toEqual([]);
      });

      it('only uses valid account types and non-empty name/code', () => {
        for (const s of seeds) {
          expect(VALID_TYPES.has(s.type)).toBe(true);
          expect(s.code).toMatch(/^\d{3,4}$/);
          expect(s.name.length).toBeGreaterThan(0);
        }
      });

      it('includes the compliance ledgers the posting engine resolves by code', () => {
        // Composition can't claim ITC, so 1103 is intentionally dropped for it.
        const required =
          businessType === 'composition'
            ? commonComplianceSeeds.filter((a) => a.code !== '1103')
            : commonComplianceSeeds;
        for (const acct of required) {
          expect(codes(seeds)).toContain(acct.code);
        }
      });
    });
  }

  it('every template carries the salary→ledger posting accounts (5003 + 1014)', () => {
    // The salary→finance bridge (salary/salary-ledger-posting.service.ts) resolves
    // 5003 Salary Expense and 1014 Salary Advance by code on EVERY firm type. 1014
    // was re-coded from 1013 (which collided with service-firm WIP) — guard so the
    // gap that silently broke advance posting can never regress.
    for (const [businessType, seeds] of Object.entries(COA_SEED_MAP)) {
      expect(codes(seeds), `${businessType} missing 5003 Salary Expense`).toContain('5003');
      expect(codes(seeds), `${businessType} missing 1014 Salary Advance`).toContain('1014');
    }
  });

  it('composition drops every input-tax-credit ledger', () => {
    const compCodes = codes(COA_SEED_MAP.composition);
    for (const itc of ['1100', '1101', '1102', '1103']) {
      expect(compCodes).not.toContain(itc);
    }
  });

  it('textile template carries the textile-trade ledgers', () => {
    const textileCodes = codes(COA_SEED_MAP.textile);
    for (const acct of textileDelta) {
      expect(textileCodes).toContain(acct.code);
    }
    // Job-work income + charges are split by process (dyeing/printing/embroidery/other).
    for (const code of ['4021', '4022', '4023', '4024', '5021', '5022', '5023', '5024']) {
      expect(textileCodes).toContain(code);
    }
    // Brokerage, interest, commercial discount.
    for (const code of ['4025', '4026', '4027', '5025', '5026']) {
      expect(textileCodes).toContain(code);
    }
  });

  it('textile delta does not collide with any base trading code', () => {
    const tradingCodes = new Set(codes(COA_SEED_MAP.trading));
    for (const acct of textileDelta) {
      expect(tradingCodes.has(acct.code)).toBe(false);
    }
  });
});
