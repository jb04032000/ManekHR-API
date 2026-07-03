import { ForbiddenException } from '@nestjs/common';

/**
 * A self-serve action the caller IS permitted to perform (they hold the RBAC
 * grant) but the WORKSPACE POLICY currently disables. Distinct from a plain
 * permission 403: it carries a machine-readable `code` plus a friendly
 * `message` and a `policyDenied: true` flag, so the frontend can render the
 * specific reason (Phase D) instead of a generic "forbidden".
 *
 * Always thrown at REQUEST time (never a silent projection-time drop) so the
 * member gets immediate, actionable feedback. Response body shape:
 *   { statusCode: 403, code, message, policyDenied: true, error: 'Forbidden' }
 *
 * Codes in use: SELF_PUNCH_DISABLED, SELF_LEAVE_DISABLED,
 * SELF_REGULARIZATION_DISABLED.
 */
export class PolicyDeniedException extends ForbiddenException {
  constructor(code: string, message: string) {
    super({ code, message, policyDenied: true });
  }
}
