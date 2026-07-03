import { describe, it, expect } from 'vitest';
import { stripPayrollConfigSensitiveFields } from '../payroll-config-read-filter';

/**
 * OQ-S3 — PayrollConfig sensitive-field read filter (Workstream G, 2026-06-14).
 *
 * The deductor sub-document (employer TAN + PAN + responsible-person PAN) and
 * the statutory registration fields (pfEstablishmentCode, esiCode) inside the
 * `statutory` sub-document must be stripped from the API response for non-HR
 * callers. HR and Owner always receive the full config. The operational toggles
 * inside `statutory` (pfEnabled, esiEnabled, ptEnabled) are NOT stripped —
 * a Manager legitimately needs them to understand why certain deductions run.
 *
 * Mirror of salary-read-filter.vitest.ts; same fail-closed-on-null pattern.
 */

function makeConfig(): Record<string, unknown> {
  return {
    workspaceId: 'ws1',
    features: { payslipGeneration: true, dailyWageLedger: false },
    statutory: {
      pfEnabled: true,
      esiEnabled: true,
      ptEnabled: false,
      pfWageCeiling: 15000,
      pfEmployeeContributionPct: 12,
      pfEmployerContributionPct: 12,
      esiEmployeeContributionPct: 0.75,
      esiEmployerContributionPct: 3.25,
      // Sensitive registration codes that MUST be stripped for non-HR:
      pfEstablishmentCode: 'MH/BAN/0000001',
      esiCode: '31-00-0000001-000',
    },
    deductor: {
      tan: 'AAAAAA0000A',
      pan: 'AAAAAAAAAA',
      responsiblePersonPan: 'BBBBBBBBBB',
      name: 'ACME PVT LTD',
      address: '123 Industrial Area',
      phone: '9876543210',
      email: 'hr@acme.com',
    },
    rules: { absentDedMode: 'per_working_day' },
    display: { currency: 'INR', payCycle: 'monthly', defaultWorkingDays: 26 },
  };
}

describe('stripPayrollConfigSensitiveFields — OQ-S3', () => {
  it('owner: full config returned (deductor and statutory codes intact)', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: true, canViewSensitive: false });
    expect(cfg.deductor).toBeDefined();
    expect((cfg.deductor as Record<string, unknown>).tan).toBe('AAAAAA0000A');
    const s = cfg.statutory as Record<string, unknown>;
    expect(s.pfEstablishmentCode).toBe('MH/BAN/0000001');
    expect(s.esiCode).toBe('31-00-0000001-000');
  });

  it('HR (canViewSensitive=true): full config returned — same as owner', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: true });
    expect(cfg.deductor).toBeDefined();
    const s = cfg.statutory as Record<string, unknown>;
    expect(s.pfEstablishmentCode).toBeDefined();
    expect(s.esiCode).toBeDefined();
  });

  it('Manager (isOwner=false, canViewSensitive=false): deductor removed entirely', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: false });
    expect(cfg.deductor).toBeUndefined();
  });

  it('Manager: pfEstablishmentCode and esiCode stripped from statutory', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: false });
    const s = cfg.statutory as Record<string, unknown>;
    expect(s.pfEstablishmentCode).toBeUndefined();
    expect(s.esiCode).toBeUndefined();
  });

  it('Manager: operational statutory toggles (pfEnabled, esiEnabled, etc.) retained', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: false });
    const s = cfg.statutory as Record<string, unknown>;
    expect(s.pfEnabled).toBe(true);
    expect(s.esiEnabled).toBe(true);
    expect(s.pfWageCeiling).toBe(15000);
  });

  it('Manager: non-statutory config fields (features, rules, display) retained', () => {
    const cfg = makeConfig();
    stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: false });
    expect(cfg.features).toBeDefined();
    expect(cfg.rules).toBeDefined();
    expect(cfg.display).toBeDefined();
  });

  it('is a no-op on null/undefined (never throws)', () => {
    expect(() =>
      stripPayrollConfigSensitiveFields(null, { isOwner: false, canViewSensitive: false }),
    ).not.toThrow();
    expect(() =>
      stripPayrollConfigSensitiveFields(undefined, { isOwner: false, canViewSensitive: false }),
    ).not.toThrow();
  });

  it('is a no-op when statutory sub-document is absent (forward-compat)', () => {
    const cfg = makeConfig();
    delete cfg.statutory;
    expect(() =>
      stripPayrollConfigSensitiveFields(cfg, { isOwner: false, canViewSensitive: false }),
    ).not.toThrow();
    // deductor is still removed even without statutory
    expect(cfg.deductor).toBeUndefined();
  });
});
