/**
 * Pure builders for the Connect Jobs board query (filter + sort).
 *
 * Kept free of Mongoose so they unit-test without a DB; the service casts the
 * result to a `FilterQuery`. These power the redesigned board's filter rail
 * (employment type / area / skills / role / pay / posted) + the sort control.
 */

export interface BoardQuery {
  category?: string;
  wageType?: string;
  district?: string;
  role?: string;
  /** Comma-separated skill names (from the filter-rail checkboxes). */
  skills?: string;
  /**
   * Comma-separated multi-select facets (the redesigned rail's checklists). When
   * present, the plural form SUPERSEDES its singular sibling above: OR within the
   * facet (csv -> $in), AND across facets. Singular params stay supported for the
   * job-detail "Similar jobs" deep link. See buildBoardFilter for the precedence.
   */
  districts?: string;
  roles?: string;
  employmentTypes?: string;
  machineTypes?: string;
  employmentType?: string;
  payMin?: number;
  payMax?: number;
  postedWithinDays?: number;
  /** Show filled roles too -- the "open positions only" toggle, switched off. */
  includeFilled?: boolean;
  sort?: string;
  /** Free-text query (the search band) -- matched on title + description + category + role. */
  q?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Anchored, case-insensitive exact-match RegExp for a single facet value. Used
 *  for district + machineType (free-text vocab; users type any casing). */
function ci(v: string): RegExp {
  return new RegExp(`^${escapeRegExp(v)}$`, 'i');
}

/** Build the Mongo filter for the open-jobs board from the rail selections. */
export function buildBoardFilter(q: BoardQuery, now: Date): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    status: q.includeFilled ? { $in: ['open', 'filled'] } : 'open',
  };

  if (q.category) filter.category = q.category;
  if (q.wageType) filter.wageType = q.wageType;

  // Plural supersedes singular (multi-select rail vs the legacy single-value deep
  // link): when a csv plural param is present we OR its values via $in and ignore
  // the singular sibling; otherwise the singular field keeps its prior behaviour.
  // role + employmentType are controlled vocab -> plain $in; district +
  // machineType are free-text -> case-insensitive RegExp $in.
  const roles = csv(q.roles);
  if (roles.length) filter.role = { $in: roles };
  else if (q.role) filter.role = q.role;

  const employmentTypes = csv(q.employmentTypes);
  if (employmentTypes.length) filter.employmentType = { $in: employmentTypes };
  else if (q.employmentType) filter.employmentType = q.employmentType;

  const districts = csv(q.districts);
  if (districts.length) filter['location.district'] = { $in: districts.map(ci) };
  else if (q.district)
    filter['location.district'] = { $regex: new RegExp(escapeRegExp(q.district), 'i') };

  const machineTypes = csv(q.machineTypes);
  if (machineTypes.length) filter.machineType = { $in: machineTypes.map(ci) };

  const skills = csv(q.skills);
  if (skills.length) filter.skills = { $in: skills };

  // Pay-range overlap: a job qualifies if its band reaches into [payMin, payMax].
  if (q.payMin != null) filter.wageMax = { $gte: q.payMin };
  if (q.payMax != null) filter.wageMin = { $lte: q.payMax };

  if (q.postedWithinDays != null && q.postedWithinDays > 0) {
    filter.createdAt = { $gte: new Date(now.getTime() - q.postedWithinDays * DAY_MS) };
  }

  const text = (q.q ?? '').trim();
  if (text) {
    const rx = new RegExp(escapeRegExp(text), 'i');
    // Also match category + role so a custom trade/occupation term typed in the
    // search band finds the job (the chips still carry the known presets).
    filter.$or = [{ title: rx }, { description: rx }, { category: rx }, { role: rx }];
  }

  return filter;
}

/** Map the sort control to a Mongo sort spec (newest-first default). `openings`
 *  replaced the old `pay` sort: sorting by wageMax mixed pay periods (a 500/month
 *  job outranked 800/day), so it was misleading. Most-openings surfaces bulk /
 *  group hiring first, a strong signal for karigars. A stale `?sort=pay` falls
 *  through to the recent default (the DTO still tolerates it - no 400).
 *
 *  Demo down-rank (Demo Content scope): every sort PREPENDS `{ isDemo: 1 }` so
 *  real jobs (isDemo=false) always sort ahead of seeded sample jobs (isDemo=true)
 *  while the community grows — without excluding samples (a demo job still shows
 *  below the real ones). The explicit user sort (openings / closing / recent) is
 *  preserved as the secondary key, so picking a sort still works as before; the
 *  demo split is just the leading tiebreaker. Covered by the
 *  { status, isDemo, createdAt } index (job.schema.ts). */
export function buildBoardSort(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case 'openings':
      return { isDemo: 1, openings: -1, createdAt: -1 };
    case 'closing':
      return { isDemo: 1, closesAt: 1, createdAt: -1 };
    case 'recent':
    default:
      return { isDemo: 1, createdAt: -1 };
  }
}
