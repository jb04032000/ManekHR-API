/**
 * Access Control Initiative - Salary A3 (2026-05-29). Strips sensitive PII
 * (bank payout + statutory IDs) from a salary response's teamMember sub-object
 * UNLESS the caller is the workspace owner, is viewing their OWN record, or
 * holds the legacy salary.sensitive_view action. Identity and amounts are
 * always retained. Mutates the passed object in place.
 */

/**
 * Explicit opt-out for INTERNAL compliance callers (ECR / ESI / bank-disbursement)
 * that legitimately need unfiltered salary data. Passing this as the salary-read
 * userId skips PII stripping. Any real request MUST pass the caller's real userId
 * so the filter is fail-closed by default.
 */
export const SALARY_INTERNAL_UNFILTERED = '__salary_internal_unfiltered__';

const SENSITIVE_FIELDS = [
  'bankDetails',
  'upiDetails',
  'preferredMethod',
  'pan',
  'uan',
  'esiIpNumber',
  'aadhaar',
] as const;

export function stripSalarySensitiveFields(
  member: Record<string, unknown> | null | undefined,
  opts: { isOwner: boolean; isOwnRecord: boolean; canViewSensitive: boolean },
): void {
  if (!member) return;
  if (opts.isOwner || opts.isOwnRecord || opts.canViewSensitive) return;
  for (const field of SENSITIVE_FIELDS) {
    if (field in member) delete member[field];
  }
}
