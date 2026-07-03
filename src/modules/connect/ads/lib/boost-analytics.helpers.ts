/**
 * Pure builders for the boost analytics surface (campaign list metrics + KPI
 * stats). Kept free of Mongoose so they unit-test without a DB; the service
 * feeds the date strings to a Mongo `$gte`/`$lte` range on the rollup `date`
 * field and applies the derivations to the summed counts.
 *
 * Honesty boundary: the `ad_daily_rollups` collection only carries
 * impressions / clicks / spend per campaign-day. These helpers therefore
 * derive ONLY ctr (clicks / impressions) and costPerClick (spend / clicks).
 * There is deliberately no inquiry / conversion / cost-per-inquiry math here
 * because those events are not attributed to a campaign anywhere in the model.
 */

/** The three raw counters summed from a set of `ad_daily_rollups` rows. */
export interface RollupCountRow {
  impressions: number;
  clicks: number;
  spend: number;
}

/** Summed counters plus the two guarded derivations exposed to the caller. */
export interface DerivedMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  /** Click-through rate: clicks / impressions. 0 when impressions = 0. */
  ctr: number;
  /** Average cost per click: spend / clicks. 0 when clicks = 0. */
  costPerClick: number;
}

/**
 * Sums impressions / clicks / spend across a set of rollup rows. Missing
 * numeric fields are treated as 0 so a sparse document never yields NaN.
 */
export function sumRollupRows(rows: ReadonlyArray<Partial<RollupCountRow>>): RollupCountRow {
  let impressions = 0;
  let clicks = 0;
  let spend = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    spend += r.spend ?? 0;
  }
  return { impressions, clicks, spend };
}

/**
 * Derives ctr + costPerClick from summed counters. Both ratios are zero-safe
 * (no NaN / Infinity): a zero denominator yields 0, the only honest answer
 * when there is nothing to divide into.
 */
export function deriveMetrics(sums: RollupCountRow): DerivedMetrics {
  return {
    impressions: sums.impressions,
    clicks: sums.clicks,
    spend: sums.spend,
    ctr: sums.impressions > 0 ? sums.clicks / sums.impressions : 0,
    costPerClick: sums.clicks > 0 ? sums.spend / sums.clicks : 0,
  };
}

// ---------------------------------------------------------------------------
// IST date-window helpers
//
// `ad_daily_rollups.date` is a 'YYYY-MM-DD' string in IST (see the schema +
// rollup.cron.ts). Windowing therefore happens on lexicographic string bounds
// so it stays index-friendly and timezone-unambiguous. The IST offset and the
// "shift then truncate" approach mirror `yesterdayIst` in rollup.cron.ts.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC + 5h30m
const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date's UTC y/m/d as 'YYYY-MM-DD'. */
function fmtYmd(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The IST wall-clock Date for an instant (used only for y/m/d extraction). */
function istWallClock(nowMs: number): Date {
  return new Date(nowMs + IST_OFFSET_MS);
}

/**
 * Inclusive 'YYYY-MM-DD' IST string bounds for the trailing 30-day window
 * ending on today (IST). The window is 30 calendar days inclusive, so the
 * start is 29 days before today.
 */
export function last30dIstDateRange(nowMs: number): {
  startDateStr: string;
  endDateStr: string;
} {
  const istToday = istWallClock(nowMs);
  const endDateStr = fmtYmd(istToday);
  const startDateStr = fmtYmd(new Date(istToday.getTime() - 29 * DAY_MS));
  return { startDateStr, endDateStr };
}

/**
 * Inclusive 'YYYY-MM-DD' IST string bounds for the current IST calendar month
 * (first day through last day of the month containing today in IST).
 */
export function currentIstMonthRange(nowMs: number): {
  startDateStr: string;
  endDateStr: string;
} {
  const istToday = istWallClock(nowMs);
  const year = istToday.getUTCFullYear();
  const month = istToday.getUTCMonth(); // 0-based

  // First day of this IST month.
  const first = new Date(Date.UTC(year, month, 1));
  // Day 0 of next month == last day of this month.
  const last = new Date(Date.UTC(year, month + 1, 0));

  return { startDateStr: fmtYmd(first), endDateStr: fmtYmd(last) };
}
