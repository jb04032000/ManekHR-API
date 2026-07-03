/**
 * Pure helpers for the public Company Page directory browse. The service runs the
 * Mongo queries; these shape the small bits that benefit from unit tests without a
 * DB: the sort selection and the specialization facet rows. Kept Mongoose-free.
 */

/** A directory facet value (a specialization tag or a district) + its real count. */
export interface BrowseFacet {
  value: string;
  count: number;
}

/**
 * Map the directory `sort` query to a Mongo sort spec. Honest orders only:
 * `name` (A->Z), `erpVerified` (ERP-linked first, then newest), or the default
 * newest-first. A stray value falls back to newest (never throws / mis-sorts).
 *
 * `erpVerified` now sorts on the CONSENT-GATED link (ADR-0004 / 2026-06-18): a
 * `'verified'` `erpLink.status` sorts ahead of `'revoked'` / absent (desc string
 * order: 'verified' > 'revoked' > null), so only genuinely-verified pages lead.
 * `erpWorkspaceId` desc then lists newest-workspace-first within the verified
 * block; `createdAt` breaks ties. (Previously sorted on `erpWorkspaceId` alone,
 * which would have led with a dangling pointer from a revoked link.)
 */
export function pickBrowseSort(sort?: string): Record<string, 1 | -1> {
  if (sort === 'name') return { name: 1 };
  if (sort === 'erpVerified') return { 'erpLink.status': -1, erpWorkspaceId: -1, createdAt: -1 };
  return { createdAt: -1 };
}

/**
 * Shape facet `$group` rows (`{ _id, count }`) into clean `{ value, count }`
 * entries: trim the value, drop blanks / zero counts, cap to `limit`. Generic --
 * reused for both the specialization and the district facet. The aggregation
 * already sorts by count desc; this guards the edges.
 */
export function toFacets(
  rows: Array<{ _id?: unknown; count?: number }>,
  limit = 12,
): BrowseFacet[] {
  const facets: BrowseFacet[] = [];
  for (const row of rows) {
    const value = typeof row._id === 'string' ? row._id.trim() : '';
    const count = row.count ?? 0;
    if (value.length > 0 && count > 0) facets.push({ value, count });
    if (facets.length >= limit) break;
  }
  return facets;
}
