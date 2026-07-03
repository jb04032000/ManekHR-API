import { describe, it, expect } from 'vitest';
import { redactPii } from '../scrub-pii';

describe('redactPii', () => {
  it('redacts values under sensitive key names (case-insensitive)', () => {
    const out = redactPii({
      password: 'hunter2',
      Authorization: 'Bearer abc.def',
      panNumber: 'ABCDE1234F',
      bankAccountNumber: '123456789012',
      ifsc: 'HDFC0001234',
      otp: '123456',
    }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
    expect(out.panNumber).toBe('[redacted]');
    expect(out.bankAccountNumber).toBe('[redacted]');
    expect(out.ifsc).toBe('[redacted]');
    expect(out.otp).toBe('[redacted]');
  });

  it('leaves non-sensitive values intact', () => {
    const out = redactPii({ name: 'Ravi', count: 5, active: true }) as Record<string, unknown>;
    expect(out.name).toBe('Ravi');
    expect(out.count).toBe(5);
    expect(out.active).toBe(true);
  });

  it('redacts an Aadhaar-shaped number embedded in a string value', () => {
    const out = redactPii({ note: 'aadhaar is 1234 5678 9012 ok' }) as Record<string, unknown>;
    expect(out.note).not.toContain('1234 5678 9012');
    expect(out.note).toContain('[redacted-id]');
  });

  it('redacts a PAN-shaped token embedded in a string value', () => {
    const out = redactPii({ note: 'pan ABCDE1234F on file' }) as Record<string, unknown>;
    expect(out.note).not.toContain('ABCDE1234F');
    expect(out.note).toContain('[redacted-id]');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactPii({
      user: { profile: { aadhaar: '123412341234' } },
      items: [{ password: 'x' }, { ok: 'keep' }],
    }) as any;
    expect(out.user.profile.aadhaar).toBe('[redacted]');
    expect(out.items[0].password).toBe('[redacted]');
    expect(out.items[1].ok).toBe('keep');
  });

  it('does not throw on circular references', () => {
    const a: any = { name: 'root' };
    a.self = a;
    expect(() => redactPii(a)).not.toThrow();
  });

  it('returns primitives unchanged (and scans bare strings)', () => {
    expect(redactPii(42)).toBe(42);
    expect(redactPii('plain text')).toBe('plain text');
    expect(redactPii('id ABCDE1234F')).toContain('[redacted-id]');
  });
});
