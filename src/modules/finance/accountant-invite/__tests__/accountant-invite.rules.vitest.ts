import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { assertInviteEmailMatch } from '../accountant-invite.rules';

// SEC-3: the accept-invite email-binding gate.
describe('assertInviteEmailMatch (accountant invite email binding)', () => {
  it('passes when the emails match exactly', () => {
    expect(() => assertInviteEmailMatch('ca@firm.com', 'ca@firm.com')).not.toThrow();
  });

  it('passes ignoring case and surrounding whitespace', () => {
    expect(() => assertInviteEmailMatch('CA@Firm.com', '  ca@firm.com  ')).not.toThrow();
  });

  it('throws Forbidden when the emails differ', () => {
    expect(() => assertInviteEmailMatch('ca@firm.com', 'someoneelse@gmail.com')).toThrow(
      ForbiddenException,
    );
  });

  it('throws when the accepting user has no email (mobile-only account)', () => {
    expect(() => assertInviteEmailMatch('ca@firm.com', undefined)).toThrow(ForbiddenException);
    expect(() => assertInviteEmailMatch('ca@firm.com', '')).toThrow(ForbiddenException);
  });

  it('throws when the invite has no email recorded', () => {
    expect(() => assertInviteEmailMatch('', 'ca@firm.com')).toThrow(ForbiddenException);
    expect(() => assertInviteEmailMatch(null, 'ca@firm.com')).toThrow(ForbiddenException);
  });
});
