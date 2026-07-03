/**
 * Pure builders for the Connect RFQ board query (filter + sort). Kept free of
 * Mongoose so they unit-test without a DB; the service casts the result to a
 * FilterQuery. These power the redesigned RFQ board's filter rail (status
 * buckets / category / districts / budget+negotiable / posted) + the sort
 * control. Mirrors the Jobs board helper (board-query.helpers.ts); the web
 * mirror is features/connect/rfq/rfq.types.ts BoardFilters.
 */

export interface RfqBoardQuery {
  category?: string;
  district?: string;
  /**
   * Comma-separated district multi-select (the rail's counted checklist). When
   * present it SUPERSEDES the singular `district` (OR within the facet via a
   * case-insensitive $in). Singular stays supported for old deep links.
   */
  districts?: string;
  /**
   * Comma-separated status buckets: open | closing-soon | awarded. Buckets are
   * DERIVED, not raw statuses: closing-soon = open AND neededBy within
   * CLOSING_SOON_DAYS; open = open and NOT closing-soon. Selecting both open
   * buckets equals plain status:'open'. Empty -> open only (prior behaviour).
   * Supersedes `includeClosed` when present.
   */
  statuses?: string;
  budgetMin?: number;
  budgetMax?: number;
  /**
   * Only meaningful alongside a budget filter: the budget range naturally
   * excludes "Negotiable" requests (null budgets); true ORs them back in.
   */
  includeNegotiable?: boolean;
  postedWithinDays?: number;
  /** Show closed/awarded requests too (legacy toggle; `statuses` supersedes). */
  includeClosed?: boolean;
  sort?: string;
  /** Free-text query (the search band) -- matched on title + description + category. */
  q?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep in sync with the web RfqCard CLOSING_SOON_DAYS (the orange badge). */
export const RFQ_CLOSING_SOON_DAYS = 3;

/** Escape user text so it is matched literally inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a csv param into trimmed, non-empty tokens (one rail checkbox each). */
function csv(s?: string): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Anchored, case-insensitive exact-match RegExp for a free-text facet value. */
function ci(v: string): RegExp {
  return new RegExp(`^${escapeRegExp(v)}$`, 'i');
}

/** The [start-of-today, end-of-window] bounds that define "closing soon". */
export function closingSoonWindow(now: Date): { from: Date; to: Date } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + (RFQ_CLOSING_SOON_DAYS + 1) * DAY_MS);
  return { from, to };
}

/** One status bucket -> its Mongo clause. Exported so boardFacets can count each
 *  bucket with the SAME definition the list filter uses (no drift). */
export function statusBucketClause(
  bucket: 'open' | 'closing-soon' | 'awarded',
  now: Date,
): Record<string, unknown> {
  const { from, to } = closingSoonWindow(now);
  switch (bucket) {
    case 'closing-soon':
      // Open AND a real needed-by inside [today, today+N]. An overdue neededBy
      // (already past) is NOT closing-soon -- it renders as plain open on the web.
      return { status: 'open', neededBy: { $gte: from, $lt: to } };
    case 'awarded':
      return { status: 'awarded' };
    case 'open':
    default:
      // Open and NOT inside the closing-soon window (no date / far out / overdue).
      return {
        status: 'open',
        $or: [{ neededBy: null }, { neededBy: { $lt: from } }, { neededBy: { $gte: to } }],
      };
  }
}

/** Build the Mongo filter for the RFQ board from the rail selections. Clauses
 *  that each need their own $or (status buckets, budget+negotiable, text search)
 *  are composed under one $and so they never clobber each other. */
export function buildRfqBoardFilter(q: RfqBoardQuery, now: Date): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  // Status: the bucket checklist supersedes includeClosed; bare board = open only.
  const buckets = csv(q.statuses).filter((b) =>
    ['open', 'closing-soon', 'awarded'].includes(b),
  ) as Array<'open' | 'closing-soon' | 'awarded'>;
  if (buckets.length) {
    const clauses = buckets.map((b) => statusBucketClause(b, now));
    if (clauses.length === 1) and.push(clauses[0]);
    else and.push({ $or: clauses });
  } else {
    filter.status = q.includeClosed ? { $in: ['open', 'awarded', 'closed'] } : 'open';
  }

  if (q.category) filter.category = q.category;

  // Districts: plural csv supersedes the singular (free-text vocab -> ci $in).
  const districts = csv(q.districts);
  if (districts.length) filter['location.district'] = { $in: districts.map(ci) };
  else if (q.district) filter['location.district'] = q.district;

  // Budget-range overlap; includeNegotiable ORs the null-budget requests back in.
  if (q.budgetMin != null || q.budgetMax != null) {
    const budget: Record<string, unknown> = {};
    if (q.budgetMin != null) budget.budgetMax = { $gte: q.budgetMin };
    if (q.budgetMax != null) budget.budgetMin = { $lte: q.budgetMax };
    if (q.includeNegotiable) {
      and.push({ $or: [budget, { budgetMin: null, budgetMax: null }] });
    } else {
      Object.assign(filter, budget);
    }
  }

  if (q.postedWithinDays != null && q.postedWithinDays > 0) {
    filter.createdAt = { $gte: new Date(now.getTime() - q.postedWithinDays * DAY_MS) };
  }

  const text = (q.q ?? '').trim();
  if (text) {
    const rx = new RegExp(escapeRegExp(text), 'i');
    // category included so a trade term typed in the search band matches (jobs parity).
    and.push({ $or: [{ title: rx }, { description: rx }, { category: rx }] });
  }

  if (and.length === 1 && !('$or' in filter)) {
    // A single composed clause can merge flat ONLY if it carries no key that the
    // base filter also sets (status buckets set `status`; the bare default does
    // not coexist with buckets, so a plain merge is safe except for collisions).
    const clause = and[0];
    const collides = Object.keys(clause).some((k) => k in filter);
    if (!collides) Object.assign(filter, clause);
    else filter.$and = and;
  } else if (and.length > 1) {
    filter.$and = and;
  }

  return filter;
}

/** Map the sort control to a Mongo sort spec (newest-first default).
 *  isDemo leads EVERY branch so real RFQs always rank above seeded demo/sample
 *  ones within the same sort (false < true). It is a down-rank, not a filter --
 *  demo still shows once real content runs out, keeping the board non-empty
 *  while the community grows. Pairs with the FE "Sample" badge (one isDemo
 *  source of truth) and demo-rank.ts on the scorer-based surfaces. */
export function buildRfqBoardSort(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case 'budget':
      return { isDemo: 1, budgetMax: -1 };
    case 'closing':
      return { isDemo: 1, neededBy: 1, createdAt: -1 };
    case 'recent':
    default:
      return { isDemo: 1, createdAt: -1 };
  }
}
