import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Suspended-account login messaging (ACCOUNT-DELETION-AND-DPDP-PLAN.md §A.2).
 *
 * When a login attempt resolves to a suspended (`isActive=false`) account, the
 * caller must tell the user WHY in a recoverable way. A DPDP self-serve
 * deletion (`accountDeletion.state==='pending'`) gets a specific
 * "scheduled for deletion on {date} — contact us to recover" error with the
 * published contact link (recovery is admin-mediated; there is no self-cancel).
 * Every other inactive account keeps the unchanged generic deactivated message.
 *
 * Pure (no IO): both AuthService login paths and SmsOtpService.assertActive
 * call it so the branch lives in exactly one place.
 */

/** Minimal structural shape this helper reads — avoids coupling to the full
 * Mongoose `User` Document (and its decorators) so the helper stays pure. */
interface SuspendableUser {
  deactivationNote?: string | null;
  accountDeletion?: { state?: string; purgeAfter?: Date } | null;
}

/** True when the account is in the DPDP self-serve deletion grace window. */
export function isPendingDeletion(user: SuspendableUser | null | undefined): boolean {
  return user?.accountDeletion?.state === 'pending';
}

/**
 * Build the right login-rejection error for a suspended account. Returns (does
 * not throw) so call sites can audit a precise reason before throwing.
 */
export function buildSuspendedAccountError(
  user: SuspendableUser | null | undefined,
  contactUrl: string,
): ForbiddenException {
  const marker = user?.accountDeletion;
  if (marker?.state === 'pending') {
    const purgeAfter = marker.purgeAfter;
    // ISO date (YYYY-MM-DD) is deterministic + locale-free; the FE re-formats
    // and localizes from the structured `purgeAfter` field (Phase 6 copy/i18n).
    const recoverByDate = purgeAfter ? new Date(purgeAfter).toISOString().slice(0, 10) : 'soon';
    return new ForbiddenException({
      code: 'ACCOUNT_SCHEDULED_FOR_DELETION',
      message:
        `Your account is scheduled for deletion on ${recoverByDate}. ` +
        `Contact us at ${contactUrl} to recover it before then.`,
      purgeAfter: purgeAfter ? new Date(purgeAfter).toISOString() : undefined,
      contactUrl,
    });
  }
  // Unchanged generic deactivated message (behavior preserved for non-pending
  // inactive accounts — e.g. an admin-suspended user).
  return new ForbiddenException(
    `Your account has been deactivated. Reason: ${user?.deactivationNote || 'No reason provided'}. Contact support.`,
  );
}

/**
 * Option B — re-signup during the 30-day deletion grace (ACCOUNT-DELETION plan §9).
 *
 * Sibling of `buildSuspendedAccountError`, for the SIGNUP side: a whole-account
 * (Scope-3) deletion keeps `email`/`mobile` populated during grace specifically
 * to block re-signup, but the generic "account already exists" conflict hides
 * WHY and offers no path back. When the conflicting account is in its grace
 * window, return a `BadRequestException` carrying the same
 * `ACCOUNT_SCHEDULED_FOR_DELETION` code + `contactUrl` + `purgeAfter` shape the
 * login rejection uses, so the auth UI can show one consistent "scheduled for
 * deletion — contact us to recover" notice instead of a dead-end error.
 *
 * Returns `null` (does NOT throw) when the account is not in whole-account grace
 * so the caller falls through to its existing conflict message. Only
 * `accountDeletion.state==='pending'` qualifies — Connect-only / ERP-only
 * deletions never suspend the account, so re-signup there is the ordinary
 * "you already have an account" case.
 *
 * Used by `AuthService.register` (the one signup path that reveals existence).
 * The SMS-OTP register path is deliberately anti-enumeration (generic response
 * for existing users) and must stay silent — those users reach this message via
 * the suspended-login branch (`buildSuspendedAccountError`) instead.
 */
export function buildPendingDeletionSignupError(
  user: SuspendableUser | null | undefined,
  contactUrl: string,
): BadRequestException | null {
  if (!isPendingDeletion(user)) return null;
  const purgeAfter = user?.accountDeletion?.purgeAfter;
  // ISO date (YYYY-MM-DD) is deterministic + locale-free; the auth UI re-formats
  // and localizes the notice from i18n keys (the BE string is the raw fallback /
  // mobile-client copy, mirroring the login rejection).
  const recoverByDate = purgeAfter ? new Date(purgeAfter).toISOString().slice(0, 10) : 'soon';
  return new BadRequestException({
    code: 'ACCOUNT_SCHEDULED_FOR_DELETION',
    message:
      `This account is scheduled for deletion on ${recoverByDate}. ` +
      `Contact us at ${contactUrl} to recover it before then.`,
    purgeAfter: purgeAfter ? new Date(purgeAfter).toISOString() : undefined,
    contactUrl,
  });
}
