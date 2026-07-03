/**
 * Pure helpers for Connect company / institute page search (SRCH-VERT-1;
 * owner-approved D1 name-search jump-to — NOT a companies directory). No Nest,
 * no Mongoose, so they unit-test without the decorator-metadata pipeline and are
 * shared by the Meili and Mongo backends in SearchService.
 *
 * Mirrors `storefront-search.helpers.ts` / `listing-search.helpers.ts` so the
 * verticals stay shape-symmetric and the federation fans out without per-vertical
 * hacks.
 *
 * Only `public` company pages reach the index (the indexer purges any
 * `connections` / `hidden` page): a draft / hidden page is never searchable. The
 * Mongo fallback re-pins `visibility: 'public'` so a stale index row cannot leak
 * a hidden page, and the result ref carries the OWNER id so the per-viewer block
 * filter + the author-active gate (`inactiveOwnerIds`) drop a blocked / banned
 * owner's page exactly like listings. `kind` (`business` | `institute`) is a
 * filterable facet so a search can narrow / label institutes.
 */

import { Types } from 'mongoose';
import { romanizedIndexField } from './transliteration';

/** The page kind discriminator — ordinary business / workshop vs training institute. */
export type ConnectPageKind = 'business' | 'institute';

/** Buyer-side filter knobs threaded through company-page search. */
export interface PageSearchFilters {
  /** Restrict to a single kind — the "Institutes" narrow / label. */
  kind?: ConnectPageKind;
  /** District / textile hub; matched case-insensitively. */
  district?: string;
  /** Restrict to a single owner's pages — the "my pages" view seam. */
  ownerUserId?: string;
}

/** Escape a value for a double-quoted Meilisearch filter literal. */
function quoteMeili(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape regex metacharacters in user input. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when at least one NARROWING facet is set. */
export function hasPageFilters(filters: PageSearchFilters): boolean {
  return Boolean(
    filters.kind || (filters.district && filters.district.trim().length > 0) || filters.ownerUserId,
  );
}

/**
 * Flatten the searchable free-tags off a page: the industry panel's
 * `specialization` (what a business does) + the institute panel's
 * `coursesOffered` (what an institute teaches) join one `tags` searchable array
 * so a member surfaces an institute by a course name, mirroring how a listing's
 * `tags` work. Lower-cased + de-duped + empties dropped.
 */
export function buildPageTags(page: {
  industryPanel?: { specialization?: string[] };
  institutePanel?: { coursesOffered?: string[] };
}): string[] {
  const raw = [
    ...(page.industryPanel?.specialization ?? []),
    ...(page.institutePanel?.coursesOffered ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of raw) {
    const t = (tag ?? '').trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * The indexed company-page document. Only `public` pages reach the index (the
 * indexer purges non-public ones), so the public gate is effectively baked in;
 * the Mongo fallback + hydration re-pin `visibility: 'public'` for safety.
 */
export interface ConnectPageDocument {
  id: string;
  name: string;
  /** `business` | `institute` — filterable facet (the institute narrow / label). */
  kind: ConnectPageKind;
  about: string;
  /** Searchable free-tags: industry specialization + institute course names. */
  tags: string[];
  district: string;
  /** The OWNER user id — carried so the block filter + author-active gate apply. */
  ownerUserId: string;
  slug: string;
  logo: string;
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script name/about/tag
   *  tokens, so a Latin query finds a Gujarati-script page. Lowest-rank
   *  searchable; `''` when all-Latin. Not displayed. */
  romanized: string;
  /** Unix ms so Meili's `createdAt:desc` ranking rule sorts numerically. */
  createdAt: number;
  /**
   * Demo Content scope: 0 for a real page, 1 for a seeded sample one. A page doc
   * carries no own `isDemo` field, so this is DERIVED from the OWNER's
   * `User.isDemo` and passed in by the indexer. Numeric so the `demoRank:asc`
   * ranking rule sinks demo below an otherwise-equal real tie.
   */
  demoRank: number;
}

/** Minimal company-page slice {@link buildPageDocument} needs. */
export interface PageForIndex {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  name: string;
  slug: string;
  kind?: ConnectPageKind;
  logo?: string;
  about?: string;
  industryPanel?: { specialization?: string[] };
  institutePanel?: { coursesOffered?: string[] };
  location?: { district?: string };
  createdAt?: Date;
  /** Demo Content scope: the OWNER's seeded-sample status (a page has no own
   *  `isDemo`). Derived + passed by the indexer. Defaults to false. */
  ownerIsDemo?: boolean;
}

/**
 * Map a company-page document to the indexed shape. District is lower-cased so
 * the `district = "surat"` filter matches regardless of how the owner typed it;
 * `kind` defaults to `business` (the schema default) so a pre-`kind` page still
 * indexes correctly; createdAt collapses to unix ms for the sort rule.
 */
export function buildPageDocument(page: PageForIndex): ConnectPageDocument {
  const tags = buildPageTags(page);
  return {
    id: String(page._id),
    name: page.name.trim(),
    kind: page.kind ?? 'business',
    about: (page.about ?? '').trim(),
    tags,
    district: (page.location?.district ?? '').trim().toLowerCase(),
    ownerUserId: String(page.ownerUserId),
    slug: page.slug,
    logo: page.logo ?? '',
    romanized: romanizedIndexField(
      page.name,
      page.about,
      page.industryPanel?.specialization,
      page.institutePanel?.coursesOffered,
    ),
    createdAt: (page.createdAt ?? new Date()).getTime(),
    // 0 real / 1 demo (derived from the owner) so `demoRank:asc` sinks sample pages.
    demoRank: page.ownerIsDemo ? 1 : 0,
  };
}

/** Meilisearch `filter` clauses (AND-ed). The index holds only `public` pages. */
export function buildPageMeiliFilter(filters: PageSearchFilters): string[] {
  const clauses: string[] = [];
  if (filters.kind) clauses.push(`kind = ${quoteMeili(filters.kind)}`);
  if (filters.district && filters.district.trim().length > 0) {
    clauses.push(`district = ${quoteMeili(filters.district.trim().toLowerCase())}`);
  }
  if (filters.ownerUserId) clauses.push(`ownerUserId = ${quoteMeili(filters.ownerUserId)}`);
  return clauses;
}

/**
 * Public company-page card shape — the federation result row for a page. A slim,
 * render-ready projection the web maps onto its page-card / search-hit UI and
 * deep-links by `slug` (`/company/[slug]`). `kind` lets the card label / badge an
 * institute distinctly.
 *
 *   - `ownerUserId` is REQUIRED by the federation gates (block filter +
 *     author-active gate route on it), so it is always present on the ref.
 */
export interface ConnectPageRef {
  pageId: string;
  ownerUserId: string;
  name: string;
  slug: string;
  kind: ConnectPageKind;
  logo: string | null;
  about: string;
  district: string;
  createdAt: Date;
}

/** Minimal (lean) company-page slice {@link toPageRef} needs. */
export interface PageForRef {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  name: string;
  slug: string;
  kind?: ConnectPageKind;
  logo?: string;
  about?: string;
  location?: { district?: string };
  createdAt?: Date;
}

/** Map a (lean) CompanyPage into the federation card shape. */
export function toPageRef(page: PageForRef): ConnectPageRef {
  return {
    pageId: String(page._id),
    ownerUserId: String(page.ownerUserId),
    name: page.name,
    slug: page.slug,
    kind: page.kind ?? 'business',
    logo: page.logo || null,
    about: (page.about ?? '').trim(),
    district: page.location?.district ?? '',
    createdAt: page.createdAt ?? new Date(),
  };
}

/**
 * Build the Mongo conditions for the company-page-search fallback. ALWAYS pins
 * `visibility: 'public'` (the public gate) so the no-Meili path never surfaces a
 * hidden / connections-only page. Mirrors the Meili filter: kind exact, district
 * case-insensitive, owner exact.
 */
export function buildPageMongoConditions(filters: PageSearchFilters): Record<string, unknown> {
  const conditions: Record<string, unknown> = { visibility: 'public' };
  if (filters.kind) conditions.kind = filters.kind;
  if (filters.district && filters.district.trim().length > 0) {
    conditions['location.district'] = new RegExp(`^${escapeRegex(filters.district.trim())}$`, 'i');
  }
  if (filters.ownerUserId) {
    conditions.ownerUserId = new Types.ObjectId(filters.ownerUserId);
  }
  return conditions;
}
