import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CompanyPageService } from './company-page.service';
import { Follow } from '../../network/schemas/follow.schema';
import { Post } from '../../feed/schemas/post.schema';
import { Job } from '../../jobs/schemas/job.schema';
import { Storefront } from '../schemas/storefront.schema';
import { Listing } from '../../marketplace/schemas/listing.schema';
import { SellerRating } from '../../reviews/schemas/seller-rating.schema';
// User backs the demo-owner lookup: the directory's "Sample" badge + feed
// down-rank both read the denormalized owner isDemo (see demo-rank.ts).
import { User } from '../../../users/schemas/user.schema';
import {
  assembleCompanyPageStats,
  type CompanyPageStatsResult,
} from '../company-page-stats.helpers';
import type { RatingValue } from '../company-page-browse-counts.helpers';

const POSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface CountRow {
  _id: Types.ObjectId;
  count: number;
}

/**
 * Company Pages hub stats: per-page followers + 30-day posts + open jobs for the
 * signed-in owner's pages, plus KPI totals. Reads the `connect*` collections
 * directly (Follow / Post / Job models registered in this module's forFeature)
 * so it never reverses the module dependency arrows (feed + jobs already depend
 * on entities). Three grouped aggregations over the owner's page-id set, then a
 * pure stitch -- no per-page N+1.
 */
@Injectable()
export class CompanyPageStatsService {
  constructor(
    private readonly pages: CompanyPageService,
    @InjectModel(Follow.name) private readonly followModel: Model<Follow>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(Job.name) private readonly jobModel: Model<Job>,
    @InjectModel(Storefront.name) private readonly storefrontModel: Model<Storefront>,
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    @InjectModel(SellerRating.name) private readonly sellerRatingModel: Model<SellerRating>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  async getMyPageStats(ownerUserId: string): Promise<CompanyPageStatsResult> {
    const pages = await this.pages.listMine(ownerUserId);
    if (pages.length === 0) {
      return assembleCompanyPageStats([], new Map(), new Map(), new Map());
    }

    const ids = pages.map((p) => new Types.ObjectId(String(p._id)));
    const cutoff = new Date(Date.now() - POSTS_WINDOW_MS);

    // Ownership is implicit + safe: `ids` only ever holds the caller's own pages,
    // so the count $groups need no extra owner filter.
    const [followerRows, postRows, jobRows] = await Promise.all([
      this.followModel.aggregate<CountRow>([
        { $match: { followeeType: 'companyPage', followeeId: { $in: ids } } },
        { $group: { _id: '$followeeId', count: { $sum: 1 } } },
      ]),
      this.postModel.aggregate<CountRow>([
        { $match: { companyPageId: { $in: ids }, deletedAt: null, createdAt: { $gte: cutoff } } },
        { $group: { _id: '$companyPageId', count: { $sum: 1 } } },
      ]),
      this.jobModel.aggregate<CountRow>([
        { $match: { companyPageId: { $in: ids }, status: 'open' } },
        { $group: { _id: '$companyPageId', count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (rows: CountRow[]): Map<string, number> =>
      new Map(rows.map((r) => [String(r._id), r.count]));

    return assembleCompanyPageStats(pages, toMap(followerRows), toMap(postRows), toMap(jobRows));
  }

  /**
   * Followers + open-jobs counts for an arbitrary set of page ids -- the public
   * company directory merges these onto its browse cards (the listing query is a
   * @Public single-collection read; these counts come from other modules). Two
   * grouped aggregations over the id set, no per-row N+1. Unknown / invalid ids
   * are dropped; absent counts are simply missing from the maps (caller defaults
   * to 0).
   */
  async countsForPages(
    ids: string[],
  ): Promise<{ followers: Map<string, number>; openJobs: Map<string, number> }> {
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) {
      return { followers: new Map(), openJobs: new Map() };
    }

    const [followerRows, jobRows] = await Promise.all([
      this.followModel.aggregate<CountRow>([
        { $match: { followeeType: 'companyPage', followeeId: { $in: objectIds } } },
        { $group: { _id: '$followeeId', count: { $sum: 1 } } },
      ]),
      this.jobModel.aggregate<CountRow>([
        { $match: { companyPageId: { $in: objectIds }, status: 'open' } },
        { $group: { _id: '$companyPageId', count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (rows: CountRow[]): Map<string, number> =>
      new Map(rows.map((r) => [String(r._id), r.count]));

    return { followers: toMap(followerRows), openJobs: toMap(jobRows) };
  }

  /**
   * Active-product counts per company page for the public directory cards. A
   * product (`Listing`) belongs to a `Storefront`, and a storefront optionally
   * links to a `CompanyPage`; "active" = publicly discoverable
   * (`status: 'active'` + `moderationStatus: 'approved'`, the same gate the
   * marketplace + storefront product list use). Two grouped, fully-indexed
   * aggregations, no per-row N+1:
   *   1. storefronts whose `companyPageId` is in the set -> a storefront-id ->
   *      page-id lookup (the `{ companyPageId: 1 }` index).
   *   2. active listings grouped by `storefrontId` for those storefronts (the
   *      `{ storefrontId: 1, status: 1, moderationStatus: 1 }` index), summed
   *      back per page id.
   * Pages with no storefront (or no active products) are simply absent from the
   * map; the caller defaults to 0.
   */
  async productCountsForPages(pageIds: string[]): Promise<Map<string, number>> {
    const pageObjectIds = pageIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (pageObjectIds.length === 0) return new Map();

    // Storefront -> page mapping (a page may have several storefronts).
    const storefronts = await this.storefrontModel
      .find({ companyPageId: { $in: pageObjectIds } })
      .select('_id companyPageId')
      .lean<Array<{ _id: Types.ObjectId; companyPageId?: Types.ObjectId | null }>>()
      .exec();
    if (storefronts.length === 0) return new Map();

    const storefrontToPage = new Map<string, string>();
    const storefrontIds: Types.ObjectId[] = [];
    for (const sf of storefronts) {
      if (!sf.companyPageId) continue;
      storefrontIds.push(sf._id);
      storefrontToPage.set(String(sf._id), String(sf.companyPageId));
    }
    if (storefrontIds.length === 0) return new Map();

    // Active products grouped by storefront, then summed back onto each page.
    const listingRows = await this.listingModel.aggregate<CountRow>([
      {
        $match: {
          storefrontId: { $in: storefrontIds },
          status: 'active',
          moderationStatus: 'approved',
        },
      },
      { $group: { _id: '$storefrontId', count: { $sum: 1 } } },
    ]);

    const byPage = new Map<string, number>();
    for (const row of listingRows) {
      const pageId = storefrontToPage.get(String(row._id));
      if (!pageId) continue;
      byPage.set(pageId, (byPage.get(pageId) ?? 0) + row.count);
    }
    return byPage;
  }

  /**
   * Seller-rating aggregates for a set of page OWNERS (the rating is author-level
   * -- `subjectUserId === ownerUserId`). ONE indexed read over the denormalized
   * `connect_seller_ratings` collection, only RATED owners (`ratingCount > 0`) so
   * an unrated owner yields no entry (the card then shows no stars). Returns a
   * `Map<ownerUserId, { ratingAvg, ratingCount }>`; `ratingAvg` is already stored
   * at 1-decimal precision (re-rounded defensively by the merge helper).
   */
  async ratingsForOwners(ownerIds: string[]): Promise<Map<string, RatingValue>> {
    const ownerObjectIds = ownerIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ownerObjectIds.length === 0) return new Map();

    const rows = await this.sellerRatingModel
      .find({ subjectUserId: { $in: ownerObjectIds }, ratingCount: { $gt: 0 } })
      .select('subjectUserId ratingAvg ratingCount')
      .lean<Array<{ subjectUserId: Types.ObjectId; ratingAvg: number; ratingCount: number }>>()
      .exec();

    return new Map(
      rows.map((r) => [
        String(r.subjectUserId),
        { ratingAvg: r.ratingAvg, ratingCount: r.ratingCount },
      ]),
    );
  }

  /**
   * Which of a set of page OWNERS are seeded demo/sample accounts (User.isDemo).
   * ONE indexed read over `users`, only the demo owners returned, so the public
   * directory card can flag its "Sample" disclosure badge + the feed/search
   * down-rank reads the SAME signal (the denormalized `isDemo` precedent). The
   * returned Set holds the ownerUserId strings that are demo; the merge helper
   * defaults any absent owner to NOT-demo (real). Mirrors `ratingsForOwners`.
   */
  async demoOwners(ownerIds: string[]): Promise<Set<string>> {
    const ownerObjectIds = ownerIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ownerObjectIds.length === 0) return new Set();

    const rows = await this.userModel
      .find({ _id: { $in: ownerObjectIds }, isDemo: true })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();

    return new Set(rows.map((r) => String(r._id)));
  }
}
