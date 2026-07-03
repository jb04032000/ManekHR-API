/**
 * Phase 17 / FIN-16-02 D-12 — GSTIN risk-level derivation.
 *
 * Pure function — given a list of GstinFilingPeriod entries (any return kind),
 * filters to GSTR-3B (the binding monthly return per CONTEXT D-12), sorts by
 * period ascending, looks at the last 3 periods, and returns the risk level:
 *
 *   OK       — all last 3 GSTR-3B periods FILED
 *   WATCH    — 1 of last 3 missed (NOT_FILED / OVERDUE) but not consecutive
 *              from the most recent end
 *   RISK     — 2 consecutive from the most recent end are missed
 *   CRITICAL — 3+ consecutive from the most recent end are missed
 *
 * Less than 3 GSTR-3B periods → 'OK' (insufficient signal — assume clean).
 *
 * Pitfall 2 (research): "consecutive from the recent end" matters — a single
 * old miss should not escalate; only a recent streak does. Walk the array
 * BACKWARDS from the most recent period.
 */
import type { GstinFilingPeriod } from './filing-status.types';
import type { GstinRiskLevel } from '../intelligence/intelligence.types';

/** Parse 'MM-YYYY' into a Date for sort. */
function parsePeriod(p: string): number {
  const [mm, yyyy] = p.split('-');
  const m = parseInt(mm, 10);
  const y = parseInt(yyyy, 10);
  if (Number.isNaN(m) || Number.isNaN(y)) return 0;
  return new Date(y, m - 1, 1).getTime();
}

/**
 * Derive risk level from the latest GSTR-3B filing periods.
 * @param periods - any GstinFilingPeriod[]; non-3B entries are filtered out.
 */
export function deriveGstinRisk(
  periods: readonly GstinFilingPeriod[] | undefined | null,
): GstinRiskLevel {
  if (!periods || periods.length === 0) return 'OK';

  // Filter to GSTR-3B only (D-12) and sort ascending by period.
  const gstr3b = periods
    .filter((p) => p.return === 'GSTR-3B')
    .slice()
    .sort((a, b) => parsePeriod(a.period) - parsePeriod(b.period));

  if (gstr3b.length < 3) return 'OK';

  const last3 = gstr3b.slice(-3);

  // Count consecutive missed periods from the most-recent end.
  // last3[2] is the most recent.
  let consecutiveMissed = 0;
  for (let i = last3.length - 1; i >= 0; i--) {
    if (last3[i].status !== 'FILED') {
      consecutiveMissed++;
    } else {
      break;
    }
  }

  if (consecutiveMissed >= 3) return 'CRITICAL';
  if (consecutiveMissed === 2) return 'RISK';

  // No consecutive miss from recent end. Were any of the 3 missed?
  const anyMissed = last3.some((p) => p.status !== 'FILED');
  if (anyMissed || consecutiveMissed === 1) return 'WATCH';
  return 'OK';
}
