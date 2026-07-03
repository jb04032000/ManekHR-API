import { BadRequestException } from '@nestjs/common';

/**
 * Phase 25 Plan 04 — Timezone-aware date range helper (Pitfall 3).
 *
 * Two collections expose two DIFFERENT temporal conventions:
 *   - ProductionLog.date     → String 'YYYY-MM-DD' in workspace tz (Pitfall 1)
 *   - DowntimeEntry.startAt  → Date (UTC instant)
 *
 * Aggregations that span both must filter each side using the matching
 * convention. `rangeToFilters()` returns BOTH shapes from one tz-local
 * (fromYmd, toYmd) input so callers can splice the right filter into each
 * `$match`.
 */

export interface RangeFilters {
  /** For ProductionLog.date — string range, inclusive both ends. */
  productionDateFilter: { $gte: string; $lte: string };
  /** For DowntimeEntry.startAt — UTC Date range, inclusive both ends. */
  downtimeStartAtFilter: { $gte: Date; $lte: Date };
  fromYmd: string;
  toYmd: string;
}

/**
 * Convert a workspace-tz-local (fromYmd, toYmd) range to both filter shapes.
 *
 * fromYmd is interpreted as local 00:00:00.000 in `tz`.
 * toYmd   is interpreted as local 23:59:59.999 in `tz`.
 *
 * The resulting Date range is the equivalent UTC instants.
 */
export function rangeToFilters(
  fromYmd: string,
  toYmd: string,
  tz: string,
): RangeFilters {
  const utcStart = parseLocalYmdToUtc(fromYmd, tz, 'start');
  const utcEnd = parseLocalYmdToUtc(toYmd, tz, 'end');
  return {
    productionDateFilter: { $gte: fromYmd, $lte: toYmd },
    downtimeStartAtFilter: { $gte: utcStart, $lte: utcEnd },
    fromYmd,
    toYmd,
  };
}

function parseLocalYmdToUtc(
  ymd: string,
  tz: string,
  edge: 'start' | 'end',
): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const localHour = edge === 'start' ? 0 : 23;
  const localMin = edge === 'start' ? 0 : 59;
  const localSec = edge === 'start' ? 0 : 59;
  const localMs = edge === 'start' ? 0 : 999;
  // Compute the tz offset on the target date using a noon UTC probe (avoids
  // DST-edge ambiguity at midnight). Round-trip via Intl.DateTimeFormat per
  // pattern in downtime.service.ts.
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzOffsetMin = getTzOffsetMin(probe, tz);
  return new Date(
    Date.UTC(y, m - 1, d, localHour, localMin, localSec, localMs) -
      tzOffsetMin * 60 * 1000,
  );
}

function getTzOffsetMin(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Service-layer span guard (D-27). class-validator can't easily compare two
 * fields, so the controller calls this after DTO validation passes.
 */
export function assertRangeWithin365Days(
  fromYmd: string,
  toYmd: string,
): void {
  const f = new Date(fromYmd + 'T00:00:00Z');
  const t = new Date(toYmd + 'T00:00:00Z');
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_RANGE',
      message: 'from/to must be valid YYYY-MM-DD dates',
    });
  }
  const days = (t.getTime() - f.getTime()) / 86_400_000 + 1;
  if (days < 1) {
    throw new BadRequestException({
      code: 'INVALID_RANGE',
      message: 'to must be on or after from',
    });
  }
  if (days > 365) {
    throw new BadRequestException({
      code: 'RANGE_TOO_LARGE',
      message: 'Date range must not exceed 365 days',
    });
  }
}

/**
 * Default range = trailing N days (inclusive of today) in workspace tz.
 * Used by KPI / trend endpoints when caller omits `from`/`to`.
 */
export function computeDefaultRangeYmd(
  tz: string,
  days = 30,
): { from: string; to: string } {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = dtf.format(now); // YYYY-MM-DD in tz (en-CA returns ISO order)
  const fromDate = new Date(now.getTime() - (days - 1) * 86_400_000);
  const from = dtf.format(fromDate);
  return { from, to: today };
}
