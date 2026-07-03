import { describe, it, expect } from 'vitest';
import { stripSalarySensitiveFields } from '../salary-read-filter';

function member() {
  return {
    name: 'A',
    designation: 'Karigar',
    avatar: 'x',
    salaryType: 'monthly',
    salaryAmount: 1000,
    bankDetails: { accountNumber: '123', ifscCode: 'IFSC' },
    upiDetails: { upiId: 'a@b' },
    preferredMethod: 'BANK',
    pan: 'ABCDE1234F',
    uan: '111',
    esiIpNumber: '222',
    aadhaar: '333',
  } as Record<string, unknown>;
}

describe('stripSalarySensitiveFields', () => {
  it('keeps everything for the owner', () => {
    const m = member();
    stripSalarySensitiveFields(m, { isOwner: true, isOwnRecord: false, canViewSensitive: false });
    expect(m.bankDetails).toBeDefined();
    expect(m.pan).toBeDefined();
  });

  it('keeps everything on the own record', () => {
    const m = member();
    stripSalarySensitiveFields(m, { isOwner: false, isOwnRecord: true, canViewSensitive: false });
    expect(m.bankDetails).toBeDefined();
    expect(m.pan).toBeDefined();
  });

  it('keeps everything when the caller holds sensitive view', () => {
    const m = member();
    stripSalarySensitiveFields(m, { isOwner: false, isOwnRecord: false, canViewSensitive: true });
    expect(m.bankDetails).toBeDefined();
    expect(m.pan).toBeDefined();
  });

  it('strips bank + statutory from another member when caller lacks sensitive view', () => {
    const m = member();
    stripSalarySensitiveFields(m, { isOwner: false, isOwnRecord: false, canViewSensitive: false });
    expect(m.bankDetails).toBeUndefined();
    expect(m.upiDetails).toBeUndefined();
    expect(m.preferredMethod).toBeUndefined();
    expect(m.pan).toBeUndefined();
    expect(m.uan).toBeUndefined();
    expect(m.esiIpNumber).toBeUndefined();
    expect(m.aadhaar).toBeUndefined();
    expect(m.name).toBe('A');
    expect(m.salaryAmount).toBe(1000);
  });

  it('is a no-op on null/undefined', () => {
    expect(() =>
      stripSalarySensitiveFields(null, {
        isOwner: false,
        isOwnRecord: false,
        canViewSensitive: false,
      }),
    ).not.toThrow();
  });
});
