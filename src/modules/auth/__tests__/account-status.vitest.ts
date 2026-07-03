/**
 * Suspended-account login messaging (ACCOUNT-DELETION-AND-DPDP-PLAN.md §A.2).
 *
 * A login attempt on an account that has been SUSPENDED must say WHY:
 *   - state==='pending' (DPDP self-serve deletion scheduled) → a specific
 *     "scheduled for deletion on {date} — contact us to recover" error with the
 *     published contact link, NOT the generic deactivated message.
 *   - any other inactive account → the unchanged generic deactivated message.
 *
 * Pure helper (no IO), so both AuthService login paths and SmsOtpService share
 * one source of truth and tests assert the branch directly.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  buildPendingDeletionSignupError,
  buildSuspendedAccountError,
  isPendingDeletion,
} from '../utils/account-status';

const CONTACT = 'https://app.example.com/support';

describe('account-status — suspended-account login messaging', () => {
  it('isPendingDeletion is true only when accountDeletion.state === "pending"', () => {
    expect(isPendingDeletion({ accountDeletion: { state: 'pending' } })).toBe(true);
    expect(isPendingDeletion({ accountDeletion: { state: 'purged' } })).toBe(false);
    expect(isPendingDeletion({})).toBe(false);
    expect(isPendingDeletion(null)).toBe(false);
  });

  it('returns the scheduled-for-deletion error (code + contact link + date) for a pending account', () => {
    const purgeAfter = new Date('2026-07-25T10:00:00.000Z');
    const err = buildSuspendedAccountError(
      { accountDeletion: { state: 'pending', purgeAfter } },
      CONTACT,
    );

    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('ACCOUNT_SCHEDULED_FOR_DELETION');
    expect(body.contactUrl).toBe(CONTACT);
    expect(body.purgeAfter).toBe(purgeAfter.toISOString());
    // The recover-by date appears in the human message, with the contact link.
    expect(String(body.message)).toContain('2026-07-25');
    expect(String(body.message)).toContain(CONTACT);
    expect(String(body.message).toLowerCase()).toContain('recover');
  });

  it('returns the unchanged generic deactivated message for a non-pending inactive account', () => {
    const err = buildSuspendedAccountError({ deactivationNote: 'admin removed' }, CONTACT);

    expect(err).toBeInstanceOf(ForbiddenException);
    // Plain-string ForbiddenException → message echoed under `message`.
    const body = err.getResponse() as { message: string };
    expect(body.message).toBe(
      'Your account has been deactivated. Reason: admin removed. Contact support.',
    );
  });

  it('falls back to "No reason provided" when there is no deactivation note', () => {
    const err = buildSuspendedAccountError({}, CONTACT);
    const body = err.getResponse() as { message: string };
    expect(body.message).toBe(
      'Your account has been deactivated. Reason: No reason provided. Contact support.',
    );
  });
});

/**
 * Option B — re-signup during the 30-day deletion grace (ACCOUNT-DELETION plan §9).
 *
 * When someone tries to sign up with an email/mobile that already belongs to a
 * whole-account (Scope-3) deletion that is still in its grace window, the signup
 * conflict must say "this account is scheduled for deletion — contact us to
 * recover it" instead of the generic "already exists". Only whole-account
 * suspension (`accountDeletion.state==='pending'`) qualifies — a Connect-only or
 * ERP-only pending deletion leaves the account ACTIVE, so re-signup there is the
 * normal "you already have an account" case (helper returns null → caller keeps
 * its existing message). Returns (does not throw) so the register site can choose
 * to fall through to its current behaviour.
 */
describe('account-status — re-signup during deletion grace (Option B)', () => {
  it('returns a scheduled-for-deletion conflict (code + contact link + date) for a pending whole-account', () => {
    const purgeAfter = new Date('2026-07-25T10:00:00.000Z');
    const err = buildPendingDeletionSignupError(
      { accountDeletion: { state: 'pending', purgeAfter } },
      CONTACT,
    );

    expect(err).toBeInstanceOf(BadRequestException);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('ACCOUNT_SCHEDULED_FOR_DELETION');
    expect(body.contactUrl).toBe(CONTACT);
    expect(body.purgeAfter).toBe(purgeAfter.toISOString());
    // The recover-by date + contact link + "recover" verb appear in the message.
    expect(String(body.message)).toContain('2026-07-25');
    expect(String(body.message)).toContain(CONTACT);
    expect(String(body.message).toLowerCase()).toContain('recover');
  });

  it('returns null for a normal existing account so the caller keeps its generic "already exists" path', () => {
    expect(buildPendingDeletionSignupError({ deactivationNote: null }, CONTACT)).toBeNull();
    expect(buildPendingDeletionSignupError({}, CONTACT)).toBeNull();
    expect(buildPendingDeletionSignupError(null, CONTACT)).toBeNull();
  });

  it('returns null for a Connect-only or ERP-only pending deletion (account stays active)', () => {
    // Only Scope-3 (whole-account, suspended) blocks re-signup. Scope-1/2 markers
    // never suspend the account, so the helper must ignore them.
    expect(
      buildPendingDeletionSignupError({ connectDeletion: { state: 'pending' } } as never, CONTACT),
    ).toBeNull();
    expect(
      buildPendingDeletionSignupError({ erpDeletion: { state: 'pending' } } as never, CONTACT),
    ).toBeNull();
  });
});
