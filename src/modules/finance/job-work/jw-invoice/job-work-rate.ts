/**
 * GST rate for textile job-work services under SAC 9988, effective 22 Sep 2025
 * (Notification 9/2025-CT(Rate)).
 *
 * - general_textile: stitching, tailoring and other general textile job-work
 *   (SAC 998821 / 998822) = 5%.
 * - embroidery: embroidery / zari job-work, a general textile process = 5%.
 *   Split out from general_textile so its income posts to its own ledger (4023).
 * - dyeing_printing: legacy combined value kept for documents created before the
 *   process split; excluded from the 5% entry since 1 Jan 2022, residuary = 18%.
 *   Posts to 4021 (Dyeing). New documents should pick `printing` (4022) when the
 *   process is printing so the income lands in the right ledger.
 * - printing: printing job-work, residuary = 18%. Income posts to 4022.
 * - other: residuary job-work not otherwise notified = 18%.
 *
 * R5: the process names (printing/embroidery) added 2026-06-11 line up the
 * jobWorkType taxonomy with the seeded textile income ledgers
 * (4021 Dyeing / 4022 Printing / 4023 Embroidery / 4024 Other) so the
 * job-work income split in LedgerPostingService.postJobWorkInvoice can route
 * each process to its own account. Keep this enum in sync with
 * jw-invoice.schema.ts, create-jw-invoice.dto.ts, and JW_INCOME_BY_TYPE.
 *
 * VERIFY-PRIMARY before go-live: confirm the dyeing/printing rate against
 * Notification 11/2017-CT(Rate) entry 26 consolidated to 22 Sep 2025. This
 * file isolates that single number.
 */
export type JobWorkType =
  | 'general_textile'
  | 'embroidery'
  | 'dyeing_printing'
  | 'printing'
  | 'other';

export const JOB_WORK_TYPES: JobWorkType[] = [
  'general_textile',
  'embroidery',
  'dyeing_printing',
  'printing',
  'other',
];

export function resolveJobWorkRate(jobWorkType?: string): number {
  switch (jobWorkType) {
    case 'dyeing_printing':
    case 'printing':
    case 'other':
      return 18;
    case 'embroidery':
    case 'general_textile':
    default:
      return 5;
  }
}
