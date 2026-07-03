import { describe, it, expect } from 'vitest';
import { isDisposableEmailDomain } from '../disposable-email';

describe('isDisposableEmailDomain', () => {
  it('flags known disposable providers', () => {
    expect(isDisposableEmailDomain('foo@yopmail.com')).toBe(true);
    expect(isDisposableEmailDomain('bar@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('baz@guerrillamail.net')).toBe(true);
    expect(isDisposableEmailDomain('qux@temp-mail.org')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isDisposableEmailDomain('A@YopMail.COM')).toBe(true);
    expect(isDisposableEmailDomain('a@ mailinator.com ')).toBe(true);
  });

  it('allows real / corporate domains', () => {
    expect(isDisposableEmailDomain('owner@gmail.com')).toBe(false);
    expect(isDisposableEmailDomain('hr@manekhr.in')).toBe(false);
    expect(isDisposableEmailDomain('user@outlook.com')).toBe(false);
  });

  it('does not throw on malformed or empty input', () => {
    expect(isDisposableEmailDomain('')).toBe(false);
    expect(isDisposableEmailDomain(undefined)).toBe(false);
    expect(isDisposableEmailDomain(null)).toBe(false);
    expect(isDisposableEmailDomain('no-at-sign')).toBe(false);
    expect(isDisposableEmailDomain('trailing@')).toBe(false);
  });

  it('matches the subdomain-free registrable domain only (uses last @)', () => {
    expect(isDisposableEmailDomain('weird@name@yopmail.com')).toBe(true);
  });
});
