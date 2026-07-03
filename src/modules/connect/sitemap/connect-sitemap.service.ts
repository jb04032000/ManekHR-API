import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Listing } from '../marketplace/schemas/listing.schema';
import { Storefront } from '../entities/schemas/storefront.schema';
import { CompanyPage } from '../entities/schemas/company-page.schema';
import { Job } from '../jobs/schemas/job.schema';
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
import { User } from '../../users/schemas/user.schema';
import { ConnectOverLimitService } from '../over-limit/connect-over-limit.service';

/**
 * Page size for each sitemap chunk. The web sitemap index emits one
 * `<sitemap>` per chunk; `counts` tells it how many chunks each section needs
 * (ceil(count / SITEMAP_CHUNK_SIZE)). 10k is the conservative per-file URL cap
 * recommended by the sitemaps.org protocol (50k hard limit), so a chunk always
 * fits one `urlset` file.
 */
export const SITEMAP_CHUNK_SIZE = 10_000;

/** The five publicly-indexable Connect entity sections. */
export const SITEMAP_SECTIONS = ['listings', 'stores', 'companyPages', 'profiles', 'jobs'] as const;
export type SitemapSection = (typeof SITEMAP_SECTIONS)[number];

/** One sitemap row: the URL path segment (id OR slug OR handle) + last-modified. */
export interface SitemapEntry {
  /** The URL path segment: listing/job = _id, store/companyPage = slug, profile = handle. */
  ref: string;
  /** ISO `updatedAt` (lastmod). */
  updatedAt: string;
}

/** Total publicly-indexable counts so the web index knows how many chunks to emit. */
export interface SitemapCounts {
  listings: number;
  stores: number;
  companyPages: number;
  profiles: number;
  jobs: number;
}

/**
 * ManekHR Connect -- Sitemap service.
 *
 * Lightweight, projection-only reads that feed the web app's dynamic sitemap
 * index (the web app cannot query Mongo directly). Each section returns ONLY the
 * URL ref (id / slug / handle) + `updatedAt` for the publicly-indexable, ACTIVE
 * entities, so a crawler's view matches the public detail routes exactly:
 *   - listings: status 'active' + moderationStatus 'approved', minus the
 *     over-limit-suppressed ids (hide_newest) -- same gate the public listing
 *     detail route 404s on.
 *   - stores / companyPages: visibility 'public'.
 *   - profiles: visibility 'public' AND a usable public handle (the URL is
 *     /u/{handle}; the handle lives on User, not ConnectProfile).
 *   - jobs: status 'open' (closed / filled never indexable).
 *
 * Paging is by 0-based `chunk` of SITEMAP_CHUNK_SIZE, sorted stably by `_id` so
 * paging is deterministic across requests (createdAt could tie; _id never does).
 * All queries are `.select()`-projected + `.lean()`.
 *
 * Cross-module: ConnectOverLimitService.getSuppressedIds is reused for the
 * listing suppression so the sitemap and the public detail route can never drift.
 */
@Injectable()
export class ConnectSitemapService {
  private readonly logger = new Logger(ConnectSitemapService.name);

  constructor(
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    @InjectModel(Storefront.name) private readonly storefrontModel: Model<Storefront>,
    @InjectModel(CompanyPage.name) private readonly companyPageModel: Model<CompanyPage>,
    @InjectModel(Job.name) private readonly jobModel: Model<Job>,
    @InjectModel(ConnectProfile.name) private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly overLimit: ConnectOverLimitService,
  ) {}

  // ── Per-section public + active filters (verified against each schema) ──────

  /** Active + admin-approved listings (the public discovery gate). */
  private readonly listingFilter = { status: 'active', moderationStatus: 'approved' } as const;
  /** Public storefronts (entity visibility enum: public | connections | hidden). */
  private readonly storeFilter = { visibility: 'public' } as const;
  /** Public company pages. */
  private readonly companyPageFilter = { visibility: 'public' } as const;
  /** Public profiles. The usable-handle requirement is applied via the User join. */
  private readonly profileFilter = { visibility: 'public' } as const;
  /** Open jobs only (closed / filled are off the board). */
  private readonly jobFilter = { status: 'open' } as const;

  /**
   * Total publicly-indexable counts per section (so the web index can emit the
   * right number of 10k chunks). The profile count is the number of PUBLIC
   * profiles whose owning user has a usable handle (a public-but-handleless
   * profile is not crawlable at /u/{handle}); the others are direct
   * countDocuments on the public/active filter.
   */
  async counts(): Promise<SitemapCounts> {
    const [listings, stores, companyPages, profiles, jobs] = await Promise.all([
      this.listingModel.countDocuments(this.listingFilter).exec(),
      this.storefrontModel.countDocuments(this.storeFilter).exec(),
      this.companyPageModel.countDocuments(this.companyPageFilter).exec(),
      this.countPublicProfilesWithHandle(),
      this.jobModel.countDocuments(this.jobFilter).exec(),
    ]);
    return { listings, stores, companyPages, profiles, jobs };
  }

  /**
   * One section's entries for a 0-based `chunk`. Validates the section + chunk,
   * then dispatches to the per-section reader. Each reader projects only the
   * ref + updatedAt and sorts by `_id` (stable paging).
   */
  async section(section: SitemapSection, chunk = 0): Promise<{ entries: SitemapEntry[] }> {
    if (!SITEMAP_SECTIONS.includes(section)) {
      throw new BadRequestException('Unknown sitemap section');
    }
    if (!Number.isInteger(chunk) || chunk < 0) {
      throw new BadRequestException('chunk must be a non-negative integer');
    }
    switch (section) {
      case 'listings':
        return { entries: await this.listingEntries(chunk) };
      case 'stores':
        return { entries: await this.storeEntries(chunk) };
      case 'companyPages':
        return { entries: await this.companyPageEntries(chunk) };
      case 'profiles':
        return { entries: await this.profileEntries(chunk) };
      case 'jobs':
        return { entries: await this.jobEntries(chunk) };
    }
  }

  // ── Section readers ─────────────────────────────────────────────────────────

  /**
   * Active + approved listings, minus over-limit-suppressed ids. SUPPRESSION IS
   * PER-OWNER, so we cannot AND it into the Mongo query across owners. Approach:
   * read the chunk's {_id, ownerUserId, updatedAt} page, then reuse the SAME
   * mechanism the public read uses -- ConnectOverLimitService.filterSuppressed
   * groups the page by owner, computes each owner's suppressed set once, and
   * drops matches. No-op under the default freeze policy, so the page is
   * unchanged unless an owner is actually over-limit on hide_newest. Reusing
   * filterSuppressed (the same call behind listPublicByStorefront's dropSuppressed)
   * guarantees the sitemap and the public detail-route 404 stay in lockstep.
   *
   * NOTE: suppression can drop rows from a chunk, so a chunk may return fewer than
   * SITEMAP_CHUNK_SIZE entries even when more exist. That is acceptable for a
   * sitemap (it only ever needs to be a superset-free list of live URLs); the web
   * index still walks every chunk via `counts`, and a suppressed listing simply
   * does not appear.
   */
  private async listingEntries(chunk: number): Promise<SitemapEntry[]> {
    const rows = await this.listingModel
      .find(this.listingFilter)
      .select('_id ownerUserId updatedAt')
      .sort({ _id: 1 })
      .skip(chunk * SITEMAP_CHUNK_SIZE)
      .limit(SITEMAP_CHUNK_SIZE)
      .lean<Array<{ _id: Types.ObjectId; ownerUserId: Types.ObjectId; updatedAt?: Date }>>()
      .exec();
    const visible = await this.overLimit.filterSuppressed(
      rows,
      'listing',
      (r) => String(r.ownerUserId),
      (r) => String(r._id),
    );
    return visible.map((r) => ({ ref: String(r._id), updatedAt: toIso(r.updatedAt) }));
  }

  /** Public storefronts; ref = slug. */
  private async storeEntries(chunk: number): Promise<SitemapEntry[]> {
    const rows = await this.storefrontModel
      .find(this.storeFilter)
      .select('slug updatedAt')
      .sort({ _id: 1 })
      .skip(chunk * SITEMAP_CHUNK_SIZE)
      .limit(SITEMAP_CHUNK_SIZE)
      .lean<Array<{ slug: string; updatedAt?: Date }>>()
      .exec();
    return rows.filter((r) => r.slug).map((r) => ({ ref: r.slug, updatedAt: toIso(r.updatedAt) }));
  }

  /** Public company pages; ref = slug. */
  private async companyPageEntries(chunk: number): Promise<SitemapEntry[]> {
    const rows = await this.companyPageModel
      .find(this.companyPageFilter)
      .select('slug updatedAt')
      .sort({ _id: 1 })
      .skip(chunk * SITEMAP_CHUNK_SIZE)
      .limit(SITEMAP_CHUNK_SIZE)
      .lean<Array<{ slug: string; updatedAt?: Date }>>()
      .exec();
    return rows.filter((r) => r.slug).map((r) => ({ ref: r.slug, updatedAt: toIso(r.updatedAt) }));
  }

  /**
   * Public profiles, ref = the owning user's handle. The handle lives on `User`
   * (not ConnectProfile) and the public URL is /u/{handle}, so we read the public
   * profile page (projected to {userId, updatedAt}), join the owning users in one
   * `$in`, and emit a row only for profiles whose user has a non-empty handle (a
   * public-but-handleless profile is not crawlable). updatedAt comes from the
   * PROFILE (its content drives the lastmod), not the user.
   */
  private async profileEntries(chunk: number): Promise<SitemapEntry[]> {
    const rows = await this.profileModel
      .find(this.profileFilter)
      .select('userId updatedAt')
      .sort({ _id: 1 })
      .skip(chunk * SITEMAP_CHUNK_SIZE)
      .limit(SITEMAP_CHUNK_SIZE)
      .lean<Array<{ userId: Types.ObjectId; updatedAt?: Date }>>()
      .exec();
    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.userId).filter(Boolean);
    // Exclude seeded demo/sample accounts (User.isDemo) from the crawlable
    // sitemap so search engines never index a demo persona as a real business.
    // isDemo defaults false and legacy users omit it, so {$ne:true} keeps every
    // real profile. Keep in sync with countPublicProfilesWithHandle below, the
    // @connect-demo.zari360.test seed, and the /u/[slug] noindex gate.
    // See DEMO-CONTENT-TRUST-UX-PLAN.md (Phase 0).
    const users = await this.userModel
      .find({ _id: { $in: userIds }, handle: { $nin: [null, ''] }, isDemo: { $ne: true } })
      .select('_id handle')
      .lean<Array<{ _id: Types.ObjectId; handle?: string | null }>>()
      .exec();
    const handleByUser = new Map(users.map((u) => [String(u._id), u.handle]));

    const entries: SitemapEntry[] = [];
    for (const r of rows) {
      const handle = handleByUser.get(String(r.userId));
      // Skip a public profile whose user has no usable handle -- /u/{handle}
      // would not resolve, so it must not enter the sitemap.
      if (!handle) continue;
      entries.push({ ref: handle, updatedAt: toIso(r.updatedAt) });
    }
    return entries;
  }

  /** Open jobs; ref = _id. */
  private async jobEntries(chunk: number): Promise<SitemapEntry[]> {
    const rows = await this.jobModel
      .find(this.jobFilter)
      .select('_id updatedAt')
      .sort({ _id: 1 })
      .skip(chunk * SITEMAP_CHUNK_SIZE)
      .limit(SITEMAP_CHUNK_SIZE)
      .lean<Array<{ _id: Types.ObjectId; updatedAt?: Date }>>()
      .exec();
    return rows.map((r) => ({ ref: String(r._id), updatedAt: toIso(r.updatedAt) }));
  }

  /**
   * Count public profiles whose owning user has a usable handle. A two-step join
   * (the handle is on `User`, not the profile): collect the public profiles'
   * userIds, then count those users with a non-empty handle. Used only for the
   * `counts` chunk math -- a small over/under by a few never-crawlable handleless
   * profiles is harmless (the web index still walks every chunk).
   */
  private async countPublicProfilesWithHandle(): Promise<number> {
    const userIds = await this.profileModel
      .find(this.profileFilter)
      .select('userId')
      .lean<Array<{ userId: Types.ObjectId }>>()
      .exec()
      .then((rows) => rows.map((r) => r.userId).filter(Boolean));
    if (userIds.length === 0) return 0;
    return (
      this.userModel
        // Match profileEntries: demo/sample accounts (User.isDemo) are excluded
        // from the sitemap, so the chunk count must exclude them too.
        .countDocuments({
          _id: { $in: userIds },
          handle: { $nin: [null, ''] },
          isDemo: { $ne: true },
        })
        .exec()
    );
  }
}

/** Coerce a possibly-undefined `updatedAt` to an ISO string (epoch fallback). */
function toIso(d?: Date): string {
  return (d instanceof Date ? d : new Date(0)).toISOString();
}
