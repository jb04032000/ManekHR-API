/**
 * Salary hardening OQ-S3 (Workstream G, 2026-06-14). Strips the employer-identity
 * statutory fields from a PayrollConfig response UNLESS the caller is the
 * workspace owner or holds `salary.sensitive_view` (the HR preset).
 *
 * The `deductor` sub-document holds the employer TAN, PAN, and the responsible
 * person's PAN (Form 24Q filing identity). The `statutory` sub-document holds the
 * PF establishment code and ESI code. These are statutory-sensitive employer
 * identifiers a Manager does not need to run payroll (the computation engine
 * reads them internally). HR + Owner receive the full config.
 *
 * Mirrors salary-read-filter.ts (the PII teamMember strip) exactly: a fail-closed
 * in-place mutation gated on the same `isOwner || canViewSensitive` discriminator,
 * so "who is HR" never diverges across the salary module.
 */

/**
 * Strip the sensitive employer-identity fields from a PayrollConfig-shaped object
 * for a non-HR caller. Mutates a PLAIN object (call on `.toObject()` / `.lean()`
 * output, never a live Mongoose document about to be saved).
 */
export function stripPayrollConfigSensitiveFields(
  config: Record<string, unknown> | null | undefined,
  opts: { isOwner: boolean; canViewSensitive: boolean },
): void {
  if (!config) return;
  if (opts.isOwner || opts.canViewSensitive) return;

  // deductor: employer TAN + PAN + responsible-person PAN + filing address/contact.
  delete config.deductor;

  // statutory: drop the registration identifiers (PF establishment code, ESI
  // code) while KEEPING the operational toggles a Manager legitimately needs to
  // read (pfEnabled / esiEnabled / ptEnabled / wage ceilings / thresholds).
  const statutory = config.statutory;
  if (statutory && typeof statutory === 'object') {
    const s = statutory as Record<string, unknown>;
    delete s.pfEstablishmentCode;
    delete s.esiCode;
  }
}
