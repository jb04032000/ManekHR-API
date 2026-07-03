/**
 * Pure helpers for Connect people / candidate search (S1.2). No Nest, no
 * Mongoose, so they unit-test without the decorator-metadata pipeline and are
 * shared by the Meili and Mongo backends in SearchService.
 */

/** Candidate facet filters threaded through people search. */
export interface PeopleSearchFilters {
  /** Skill tags; a result matches if it carries ANY of them (facet OR). */
  skills?: string[];
  /** Home district / textile hub; matched case-insensitively. */
  district?: string;
  /** Restrict to members who toggled "open to work". */
  openToWork?: boolean;
  /**
   * Restrict to members who toggled "Providing services" (the `openTo.customOrders`
   * intent). Powers the "Find a Service" provider filter on people search.
   */
  providingServices?: boolean;
}

/** 365-day years keep the experience derivation deterministic + test-stable. */
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** Escape regex metacharacters in user input. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a value for a double-quoted Meilisearch filter literal. */
function quoteMeili(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Lowercase + trim + de-duplicate skill tags for consistent index + filter matching. */
export function normalizeSkillsForIndex(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    const skill = raw.trim().toLowerCase();
    if (skill.length > 0 && !seen.has(skill)) {
      seen.add(skill);
      out.push(skill);
    }
  }
  return out;
}

/** True when at least one facet is set (an empty skills array does not count). */
export function hasPeopleFilters(filters: PeopleSearchFilters): boolean {
  return Boolean(
    (filters.skills && filters.skills.length > 0) ||
    (filters.district && filters.district.trim().length > 0) ||
    filters.openToWork ||
    filters.providingServices,
  );
}

/**
 * Total years of trade experience, summed across engagements and floored. An
 * engagement with no `from` is ignored; an ongoing one (`to` null) counts up to
 * `now`; a non-positive span contributes 0. A whole-year signal for ranking and
 * sort, not a precise statistic.
 */
export function deriveExperienceYears(
  items: ReadonlyArray<{ from?: Date | null; to?: Date | null }>,
  now: Date = new Date(),
): number {
  let totalMs = 0;
  for (const item of items) {
    if (!item.from) continue;
    const end = item.to ?? now;
    const span = end.getTime() - item.from.getTime();
    if (span > 0) totalMs += span;
  }
  return Math.floor(totalMs / MS_PER_YEAR);
}

/**
 * Build the Meilisearch `filter` clauses (AND-ed) for the people facets. Skill
 * and district values are lowercased to match the lowercased indexed fields.
 */
export function buildPeopleMeiliFilter(filters: PeopleSearchFilters): string[] {
  const clauses: string[] = [];
  if (filters.skills && filters.skills.length > 0) {
    const list = normalizeSkillsForIndex(filters.skills).map(quoteMeili).join(', ');
    clauses.push(`skills IN [${list}]`);
  }
  if (filters.district && filters.district.trim().length > 0) {
    clauses.push(`district = ${quoteMeili(filters.district.trim().toLowerCase())}`);
  }
  if (filters.openToWork) {
    clauses.push('openToWork = true');
  }
  // "Providing services" provider filter -> the denormalized providingServices
  // boolean on the people doc (= profile.openTo.customOrders).
  if (filters.providingServices) {
    clauses.push('providingServices = true');
  }
  return clauses;
}

/**
 * Build the extra Mongo conditions for the people facets, merged into the
 * fallback profile query. Mirrors the Meili filter so both backends return the
 * same candidates: skills + district match case-insensitively; openToWork maps
 * to the embedded `openTo.work` flag.
 */
export function buildPeopleMongoConditions(filters: PeopleSearchFilters): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  if (filters.skills && filters.skills.length > 0) {
    conditions.skills = {
      $in: normalizeSkillsForIndex(filters.skills).map(
        (skill) => new RegExp(`^${escapeRegex(skill)}$`, 'i'),
      ),
    };
  }
  if (filters.district && filters.district.trim().length > 0) {
    conditions.district = new RegExp(
      `^${escapeRegex(filters.district.trim().toLowerCase())}$`,
      'i',
    );
  }
  if (filters.openToWork) {
    conditions['openTo.work'] = true;
  }
  // Mirror the Meili providingServices clause on the embedded profile flag so
  // the Mongo fallback returns the same providers.
  if (filters.providingServices) {
    conditions['openTo.customOrders'] = true;
  }
  return conditions;
}
