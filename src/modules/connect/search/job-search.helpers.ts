/**
 * Pure helpers for Connect job search (Phase 5). No Nest, no Mongoose, so they
 * unit-test without the decorator-metadata pipeline and are shared by the Meili
 * and Mongo backends in SearchService.
 *
 * Mirrors `post-search.helpers.ts` / `listing-search.helpers.ts` so the verticals
 * stay shape-symmetric and the federation fans out without per-vertical hacks.
 *
 * Only OPEN jobs reach the index (the indexer purges closed / filled jobs): a
 * job that is no longer hiring is never searchable. The Mongo fallback re-pins
 * `status: 'open'` so a stale index row cannot leak a closed job.
 */

import { Types } from 'mongoose';
import { romanizedIndexField } from './transliteration';

/** Buyer-side filter knobs threaded through job search. */
export interface JobSearchFilters {
  /** Restrict to one trade category (a known slug or a custom term). */
  category?: string;
  /** Restrict to jobs posted by one company page. */
  companyPageId?: string;
}

function quoteMeili(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function hasJobFilters(filters: JobSearchFilters): boolean {
  return Boolean(filters.category || filters.companyPageId);
}

/**
 * The indexed job document. One per OPEN job. `title` + `description` +
 * `category` + `role` are searchable; `createdAt` is the recency ranking signal.
 * `category` / `companyPageId` / `district` are facets.
 */
export interface ConnectJobDocument {
  id: string;
  title: string;
  description: string;
  category: string;
  role: string;
  companyUserId: string;
  companyPageId: string | null;
  district: string;
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script title/description/
   *  category/role tokens. Lowest-rank searchable; `''` when all-Latin. Not displayed. */
  romanized: string;
  createdAt: number;
  /**
   * Demo Content scope: 0 for a real job, 1 for a seeded sample one (read from
   * the job's denormalized `isDemo`). Numeric so the `demoRank:asc` ranking rule
   * sinks demo below an otherwise-equal real tie. Same flag the web "Sample"
   * badge + demo-rank.ts down-rank read.
   */
  demoRank: number;
}

/** Minimal job slice {@link buildJobDocument} needs. */
export interface JobForIndex {
  _id: Types.ObjectId | string;
  title: string;
  description?: string;
  category: string;
  role?: string | null;
  companyUserId: Types.ObjectId | string;
  companyPageId?: Types.ObjectId | string | null;
  location?: { district?: string };
  createdAt?: Date;
  /** Denormalized seeded-sample marker (Demo Content scope), stamped at create
   *  from the poster's `User.isDemo`. Defaults to false on a legacy row. */
  isDemo?: boolean;
}

/** Map a job into the indexed shape. */
export function buildJobDocument(job: JobForIndex): ConnectJobDocument {
  return {
    id: String(job._id),
    title: job.title.trim(),
    description: (job.description ?? '').trim(),
    category: job.category,
    role: job.role ?? '',
    companyUserId: String(job.companyUserId),
    companyPageId: job.companyPageId ? String(job.companyPageId) : null,
    district: job.location?.district ?? '',
    romanized: romanizedIndexField(job.title, job.description, job.category, job.role),
    createdAt: (job.createdAt ?? new Date()).getTime(),
    // 0 real / 1 demo so the `demoRank:asc` rule sinks seeded sample jobs.
    demoRank: job.isDemo ? 1 : 0,
  };
}

/** Meilisearch `filter` clauses (AND-ed). The index holds only open jobs. */
export function buildJobMeiliFilter(filters: JobSearchFilters): string[] {
  const clauses: string[] = [];
  if (filters.category) clauses.push(`category = ${quoteMeili(filters.category)}`);
  if (filters.companyPageId) clauses.push(`companyPageId = ${quoteMeili(filters.companyPageId)}`);
  return clauses;
}

/**
 * Public job card shape - the federation result row for a job. A render-ready
 * projection the web maps straight onto its `Job` type (so the existing JobCard
 * renders a search hit identically to a board row). No author hydration needed.
 */
export interface ConnectJobRef {
  _id: string;
  companyUserId: string;
  companyPageId: string | null;
  title: string;
  description: string;
  category: string;
  role: string | null;
  wageType: string | null;
  wageMin: number | null;
  wageMax: number | null;
  openings: number;
  location: { district?: string; city?: string; state?: string };
  status: string;
  applicationsCount: number;
  boostCampaignId: string | null;
  createdAt?: Date;
}

/** Minimal (lean) job slice {@link toJobRef} needs. */
export interface JobForRef {
  _id: Types.ObjectId | string;
  companyUserId: Types.ObjectId | string;
  companyPageId?: Types.ObjectId | string | null;
  title: string;
  description?: string;
  category: string;
  role?: string | null;
  wageType?: string | null;
  wageMin?: number | null;
  wageMax?: number | null;
  openings?: number;
  location?: { district?: string; city?: string; state?: string };
  status: string;
  applicationsCount?: number;
  boostCampaignId?: Types.ObjectId | string | null;
  createdAt?: Date;
}

/** Map a (lean) Job into the federation card shape. */
export function toJobRef(job: JobForRef): ConnectJobRef {
  return {
    _id: String(job._id),
    companyUserId: String(job.companyUserId),
    companyPageId: job.companyPageId ? String(job.companyPageId) : null,
    title: job.title,
    description: (job.description ?? '').trim(),
    category: job.category,
    role: job.role ?? null,
    wageType: job.wageType ?? null,
    wageMin: job.wageMin ?? null,
    wageMax: job.wageMax ?? null,
    openings: job.openings ?? 1,
    location: job.location ?? {},
    status: job.status,
    applicationsCount: job.applicationsCount ?? 0,
    boostCampaignId: job.boostCampaignId ? String(job.boostCampaignId) : null,
    createdAt: job.createdAt,
  };
}

/** Mongo conditions for the job-search fallback. ALWAYS pins `status: 'open'`. */
export function buildJobMongoConditions(filters: JobSearchFilters): Record<string, unknown> {
  const conditions: Record<string, unknown> = { status: 'open' };
  if (filters.category) conditions.category = filters.category;
  if (filters.companyPageId) conditions.companyPageId = new Types.ObjectId(filters.companyPageId);
  return conditions;
}
