/**
 * Pure helpers for Connect storefront (shop) search (SRCH-VERT-1). No Nest, no
 * Mongoose, so they unit-test without the decorator-metadata pipeline and are
 * shared by the Meili and Mongo backends in SearchService.
 *
 * Mirrors `listing-search.helpers.ts` / `job-search.helpers.ts` so the verticals
 * stay shape-symmetric and the federation fans out without per-vertical hacks.
 *
 * Only `public` storefronts reach the index (the indexer purges any
 * `connections` / `hidden` shop): a draft / hidden shop is never searchable. The
 * Mongo fallback re-pins `visibility: 'public'` so a stale index row cannot leak
 * a hidden shop, and the result ref carries the OWNER id so the per-viewer block
 * filter + the author-active gate (`inactiveOwnerIds`) drop a blocked / banned
 * owner's shop exactly like listings.
 */

import { Types } from 'mongoose';
import { romanizedIndexField } from './transliteration';

/** Buyer-side filter knobs threaded through storefront search. */
export interface StorefrontSearchFilters {
  /** Seller district / textile hub; matched case-insensitively. */
  district?: string;
  /** Restrict to a single owner's shops — the seam the "my shops" view can reuse. */
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
export function hasStorefrontFilters(filters: StorefrontSearchFilters): boolean {
  return Boolean((filters.district && filters.district.trim().length > 0) || filters.ownerUserId);
}

/**
 * The indexed storefront document. Only `public` storefronts reach the index
 * (the indexer purges non-public ones), so the public gate is effectively baked
 * in; the Mongo fallback + hydration re-pin `visibility: 'public'` for safety in
 * case a stale doc lingers between a visibility flip and the next reindex.
 */
export interface ConnectStorefrontDocument {
  id: string;
  name: string;
  description: string;
  /** Free category tags (lower-cased for filtering). */
  categories: string[];
  district: string;
  /** The OWNER user id — carried so the block filter + author-active gate apply. */
  ownerUserId: string;
  slug: string;
  logo: string;
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script name/description/
   *  category tokens, so a Latin query finds a Gujarati-script shop. Lowest-rank
   *  searchable; `''` when all-Latin. Not displayed. */
  romanized: string;
  /** Unix ms so Meili's `createdAt:desc` ranking rule sorts numerically. */
  createdAt: number;
  /**
   * Demo Content scope: 0 for a real shop, 1 for a seeded sample one. A
   * storefront doc carries no own `isDemo` field, so this is DERIVED from the
   * OWNER's `User.isDemo` and passed in by the indexer. Numeric so the
   * `demoRank:asc` ranking rule sinks demo below an otherwise-equal real tie.
   */
  demoRank: number;
}

/** Minimal storefront slice {@link buildStorefrontDocument} needs. */
export interface StorefrontForIndex {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  name: string;
  slug: string;
  logo?: string;
  description?: string;
  categories?: string[];
  location?: { district?: string };
  createdAt?: Date;
  /** Demo Content scope: the OWNER's seeded-sample status (a storefront has no
   *  own `isDemo`). Derived + passed by the indexer. Defaults to false. */
  ownerIsDemo?: boolean;
}

/**
 * Map a storefront document to the indexed shape. District + categories are
 * lower-cased so the `district = "surat"` filter matches regardless of how the
 * owner typed it; createdAt collapses to unix ms for the sort rule.
 */
export function buildStorefrontDocument(storefront: StorefrontForIndex): ConnectStorefrontDocument {
  const categories = (storefront.categories ?? [])
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return {
    id: String(storefront._id),
    name: storefront.name.trim(),
    description: (storefront.description ?? '').trim(),
    categories,
    district: (storefront.location?.district ?? '').trim().toLowerCase(),
    ownerUserId: String(storefront.ownerUserId),
    slug: storefront.slug,
    logo: storefront.logo ?? '',
    romanized: romanizedIndexField(storefront.name, storefront.description, storefront.categories),
    createdAt: (storefront.createdAt ?? new Date()).getTime(),
    // 0 real / 1 demo (derived from the owner) so `demoRank:asc` sinks sample shops.
    demoRank: storefront.ownerIsDemo ? 1 : 0,
  };
}

/**
 * Build the Meilisearch `filter` clauses (AND-ed) for storefront search. The
 * index holds only `public` shops, so no visibility clause is needed (the
 * indexer + the hydration re-pin enforce it).
 */
export function buildStorefrontMeiliFilter(filters: StorefrontSearchFilters): string[] {
  const clauses: string[] = [];
  if (filters.district && filters.district.trim().length > 0) {
    clauses.push(`district = ${quoteMeili(filters.district.trim().toLowerCase())}`);
  }
  if (filters.ownerUserId) clauses.push(`ownerUserId = ${quoteMeili(filters.ownerUserId)}`);
  return clauses;
}

/**
 * Public storefront card shape — the federation result row for a shop. A slim,
 * render-ready projection the web maps onto its store-card / search-hit UI and
 * deep-links by `slug` (`/store/[slug]`).
 *
 *   - `ownerUserId` is REQUIRED by the federation gates (block filter +
 *     author-active gate route on it), so it is always present on the ref.
 *   - `district` carries the original casing the owner typed (the indexed doc
 *     lower-cases for filtering; the card needs the human form).
 */
export interface ConnectStorefrontRef {
  storefrontId: string;
  ownerUserId: string;
  name: string;
  slug: string;
  logo: string | null;
  description: string;
  categories: string[];
  district: string;
  createdAt: Date;
}

/** Minimal (lean) storefront slice {@link toStorefrontRef} needs. */
export interface StorefrontForRef {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  name: string;
  slug: string;
  logo?: string;
  description?: string;
  categories?: string[];
  location?: { district?: string };
  createdAt?: Date;
}

/** Map a (lean) Storefront into the federation card shape. */
export function toStorefrontRef(storefront: StorefrontForRef): ConnectStorefrontRef {
  return {
    storefrontId: String(storefront._id),
    ownerUserId: String(storefront.ownerUserId),
    name: storefront.name,
    slug: storefront.slug,
    logo: storefront.logo || null,
    description: (storefront.description ?? '').trim(),
    categories: storefront.categories ?? [],
    district: storefront.location?.district ?? '',
    createdAt: storefront.createdAt ?? new Date(),
  };
}

/**
 * Build the Mongo conditions for the storefront-search fallback. ALWAYS pins
 * `visibility: 'public'` (the public gate) so the no-Meili path never surfaces a
 * hidden / connections-only shop. Mirrors the Meili filter: district
 * case-insensitive, owner exact.
 */
export function buildStorefrontMongoConditions(
  filters: StorefrontSearchFilters,
): Record<string, unknown> {
  const conditions: Record<string, unknown> = { visibility: 'public' };
  if (filters.district && filters.district.trim().length > 0) {
    conditions['location.district'] = new RegExp(`^${escapeRegex(filters.district.trim())}$`, 'i');
  }
  if (filters.ownerUserId) {
    conditions.ownerUserId = new Types.ObjectId(filters.ownerUserId);
  }
  return conditions;
}
