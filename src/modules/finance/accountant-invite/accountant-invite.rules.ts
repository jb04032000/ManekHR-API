import { ForbiddenException } from '@nestjs/common';

/**
 * SEC-3: an accountant invite is addressed to a specific email. The invite token
 * alone must NOT grant access - otherwise a forwarded or leaked accept link could
 * be used by anyone who is merely signed in. So at accept time the authenticated
 * user's account email must match the invited email.
 *
 * Comparison is trimmed + case-insensitive. A user with no email (mobile-only
 * account) can never match an email invite, which is the correct, safe outcome.
 *
 * Pure function so it is unit-tested in isolation without standing up the
 * accept transaction and its Mongoose dependencies.
 */
export function assertInviteEmailMatch(
  invitedEmail: string | null | undefined,
  userEmail: string | null | undefined,
): void {
  const invited = (invitedEmail ?? '').trim().toLowerCase();
  const actual = (userEmail ?? '').trim().toLowerCase();
  if (!invited || !actual || invited !== actual) {
    throw new ForbiddenException(
      'This invite was sent to a different email address. Sign in with the invited account to accept it.',
    );
  }
}
