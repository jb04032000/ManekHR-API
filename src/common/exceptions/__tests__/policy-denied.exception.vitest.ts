import { describe, it, expect } from 'vitest';
import { PolicyDeniedException } from '../policy-denied.exception';

describe('PolicyDeniedException', () => {
  it('is a 403 carrying code + friendly message + policyDenied flag (the FE contract)', () => {
    const ex = new PolicyDeniedException('SELF_PUNCH_DISABLED', 'Self check-in is turned off.');
    expect(ex.getStatus()).toBe(403);
    expect(ex.getResponse()).toEqual({
      code: 'SELF_PUNCH_DISABLED',
      message: 'Self check-in is turned off.',
      policyDenied: true,
    });
  });

  it('preserves distinct codes for the three self-serve policy gates', () => {
    for (const code of [
      'SELF_LEAVE_DISABLED',
      'SELF_REGULARIZATION_DISABLED',
      'SELF_PUNCH_DISABLED',
    ]) {
      const ex = new PolicyDeniedException(code, 'msg');
      expect((ex.getResponse() as { code: string }).code).toBe(code);
    }
  });
});
