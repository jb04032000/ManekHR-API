/**
 * Formats a Date as `YYYYMMDD` per Tally `<DATE>` requirements.
 *
 * Tally rejects ISO-8601, slash-separated, and dash-separated date strings.
 * Only contiguous 8-digit YYYYMMDD is accepted by both ERP 9 and TallyPrime.
 *
 * Uses local-time getters (firm books are filed in Indian local time;
 * UTC drift is acceptable for accounting cutoffs and matches existing
 * voucherDate semantics in repo).
 */
export function dateYyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
