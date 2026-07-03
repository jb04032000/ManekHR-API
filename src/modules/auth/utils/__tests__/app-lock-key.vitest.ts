import { describe, it, expect } from 'vitest';
import { appLockKey } from '../app-lock-key';

describe('appLockKey', () => {
  it('keys on family when present', () => {
    expect(appLockKey('unlocked', { family: 'fam-1', jti: 'jti-1' })).toBe('unlocked:fam:fam-1');
    expect(appLockKey('setup-grace', { family: 'fam-1' })).toBe('setup-grace:fam:fam-1');
  });

  it('falls back to jti for legacy tokens with no family', () => {
    expect(appLockKey('unlocked', { jti: 'jti-1' })).toBe('unlocked:jti:jti-1');
  });

  it('returns null when neither id is present', () => {
    expect(appLockKey('unlocked', {})).toBeNull();
  });
});
