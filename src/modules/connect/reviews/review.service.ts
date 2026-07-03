import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Review, type ReviewDocument } from './schemas/review.schema';
import { SellerRating, type SellerRatingDocument } from './schemas/seller-rating.schema';
import type { UpsertReviewDto } from './dto/review.dto';

/** The public-facing rating aggregate for a seller. */
export interface RatingAggregate {
  ratingAvg: number;
  ratingCount: number;
}

/** The reviewer's viewer-facing identity, populated on the public list. */
export interface PublicReviewer {
  _id: Types.ObjectId | string;
  name?: string;
  profilePicture?: string;
  handle?: string | null;
}

/** A review with its reviewer's identity populated (the public list shape). */
export interface PublicReview {
  _id: Types.ObjectId | string;
  reviewerUserId: PublicReviewer | Types.ObjectId | string;
  rating: number;
  text: string;
  verifiedPurchase: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Review counts per star (1-5) -- the detail-page score bars. */
export type RatingDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

/** A page of a seller's reviews + their aggregate. */
export interface SellerReviewsPage {
  reviews: PublicReview[];
  aggregate: RatingAggregate;
  nextCursor: string | null;
  /** Star breakdown, computed on the FIRST page only (omitted on cursor pages). */
  distribution?: RatingDistribution;
}

const PAGE_SIZE = 20;
/** Wilson z-score (95% confidence) for the quality lower bound. */
const WILSON_Z = 1.96;
/** A rating at or above this is a Wilson "positive". */
const POSITIVE_THRESHOLD = 4;

/**
 * `ReviewService` — marketplace Phase C. Reviews are person-centric (rate a
 * `subjectUserId`), one-per-(reviewer, subject) and editable, self-review
 * blocked, reportable. Every write recomputes the denormalized `SellerRating`
 * aggregate so reads are a single doc. Open to any signed-in member in v1; the
 * `verifiedPurchase` trust gate is reserved.
 */
@Injectable()
export class ReviewService {
  constructor(
    @InjectModel(Review.name) private readonly reviewModel: Model<ReviewDocument>,
    @InjectModel(SellerRating.name)
    private readonly sellerRatingModel: Model<SellerRatingDocument>,
  ) {}

  /**
   * Per-subject coalescing state for the denormalized-aggregate recompute.
   * `recomputeInFlight` holds the running recompute promise for a subject;
   * `recomputeDirty` flags that another write landed mid-run so the running
   * pass repeats once more. Rapid writes to the SAME seller collapse onto one
   * in-flight recompute (plus at most one trailing pass), so N concurrent writes
   * do far fewer than N read+persist cycles. The aggregate may trail the last
   * write by one cycle (sub-second under load); that staleness is acceptable for
   * a display rating and self-heals on the next write.
   */
  private readonly recomputeInFlight = new Map<string, Promise<void>>();
  private readonly recomputeDirty = new Set<string>();

  /** Create or edit the caller's review of a seller. Self-review is rejected. */
  async upsert(
    reviewerUserId: string | Types.ObjectId,
    dto: UpsertReviewDto,
  ): Promise<ReviewDocument> {
    const reviewer = this.toObjectId(reviewerUserId);
    const subject = new Types.ObjectId(dto.subjectUserId);
    if (reviewer.equals(subject)) {
      throw new BadRequestException('You cannot review yourself.');
    }
    const review = await this.reviewModel
      .findOneAndUpdate(
        { reviewerUserId: reviewer, subjectUserId: subject },
        {
          $set: { rating: dto.rating, text: dto.text?.trim() ?? '' },
          $setOnInsert: { verifiedPurchase: false, status: 'active', reportCount: 0 },
        },
        { upsert: true, new: true },
      )
      .exec();
    await this.recomputeAggregate(subject);
    return review;
  }

  /** Delete the caller's review of a seller. */
  async remove(reviewerUserId: string | Types.ObjectId, subjectUserId: string): Promise<void> {
    const subject = new Types.ObjectId(subjectUserId);
    const res = await this.reviewModel
      .deleteOne({ reviewerUserId: this.toObjectId(reviewerUserId), subjectUserId: subject })
      .exec();
    if (res.deletedCount === 0) throw new NotFoundException('Review not found.');
    await this.recomputeAggregate(subject);
  }

  /** The caller's own review of a seller (for the edit form), or null. */
  async getMine(
    reviewerUserId: string | Types.ObjectId,
    subjectUserId: string,
  ): Promise<ReviewDocument | null> {
    return this.reviewModel
      .findOne({
        reviewerUserId: this.toObjectId(reviewerUserId),
        subjectUserId: new Types.ObjectId(subjectUserId),
      })
      .exec();
  }

  /** A seller's active reviews (newest first) + the aggregate. Public. */
  async listForSeller(subjectUserId: string, cursor?: string): Promise<SellerReviewsPage> {
    if (!Types.ObjectId.isValid(subjectUserId)) {
      return { reviews: [], aggregate: { ratingAvg: 0, ratingCount: 0 }, nextCursor: null };
    }
    const subject = new Types.ObjectId(subjectUserId);
    const filter: Record<string, unknown> = { subjectUserId: subject, status: 'active' };
    if (cursor) {
      const d = new Date(cursor);
      if (!Number.isNaN(d.getTime())) filter.createdAt = { $lt: d };
    }
    const reviews = await this.reviewModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(PAGE_SIZE)
      // The card shows who wrote each review — populate the reviewer's
      // viewer-facing identity (name + avatar + handle), canonical on `User`.
      .populate('reviewerUserId', 'name profilePicture handle')
      .select('reviewerUserId rating text verifiedPurchase createdAt updatedAt')
      .lean<PublicReview[]>()
      .exec();
    const aggregate = await this.getAggregate(subjectUserId);
    const nextCursor =
      reviews.length < PAGE_SIZE
        ? null
        : (reviews[reviews.length - 1].createdAt?.toISOString() ?? null);
    // Star breakdown for the score bars -- first page only (one indexed $group;
    // cursor pages reuse the bars the client already has).
    const distribution = cursor ? undefined : await this.getDistribution(subject);
    return { reviews, aggregate, nextCursor, ...(distribution ? { distribution } : {}) };
  }

  /** Active-review counts per star (1-5) for one seller. Zeros when unrated. */
  private async getDistribution(subject: Types.ObjectId): Promise<RatingDistribution> {
    const distribution: RatingDistribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    const rows = await this.reviewModel
      .aggregate<{
        _id: number;
        count: number;
      }>([
        { $match: { subjectUserId: subject, status: 'active' } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ])
      .exec();
    for (const row of rows) {
      const star = String(row._id) as keyof RatingDistribution;
      if (star in distribution) distribution[star] = row.count;
    }
    return distribution;
  }

  /** Report a review (abuse). Increments the counter; moderation is a follow-up. */
  async report(reviewId: string): Promise<void> {
    if (!Types.ObjectId.isValid(reviewId)) throw new NotFoundException('Review not found.');
    const res = await this.reviewModel
      .updateOne({ _id: new Types.ObjectId(reviewId) }, { $inc: { reportCount: 1 } })
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Review not found.');
    // TODO(review-mod): auto-hide past a report threshold + a moderation queue.
  }

  /** The display aggregate for one seller (zeros when unrated). */
  async getAggregate(subjectUserId: string): Promise<RatingAggregate> {
    if (!Types.ObjectId.isValid(subjectUserId)) return { ratingAvg: 0, ratingCount: 0 };
    const row = await this.sellerRatingModel
      .findOne({ subjectUserId: new Types.ObjectId(subjectUserId) })
      .select('ratingAvg ratingCount')
      .lean<{ ratingAvg: number; ratingCount: number }>()
      .exec();
    return { ratingAvg: row?.ratingAvg ?? 0, ratingCount: row?.ratingCount ?? 0 };
  }

  /** Batched aggregates for surfacing on cards/lists — only RATED sellers
   *  (ratingCount > 0) so an unrated seller renders no stars. */
  async getAggregatesFor(subjectUserIds: string[]): Promise<Map<string, RatingAggregate>> {
    const ids = subjectUserIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.sellerRatingModel
      .find({ subjectUserId: { $in: ids }, ratingCount: { $gt: 0 } })
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
   * Subject userIds whose displayed rating meets `min` (and who are actually
   * rated, ratingCount > 0). Backs the directory's minimum-rating filter -
   * callers add `ownerUserId: { $in: ids }` to their query so pagination stays
   * correct. Returns ids as strings.
   */
  async ownersWithMinRating(min: number): Promise<string[]> {
    const rows = await this.sellerRatingModel
      .find({ ratingCount: { $gt: 0 }, ratingAvg: { $gte: min } })
      .select('subjectUserId')
      .lean<Array<{ subjectUserId: Types.ObjectId }>>()
      .exec();
    return rows.map((r) => String(r.subjectUserId));
  }

  /**
   * Coalesce the aggregate recompute for a subject. If a recompute is already
   * running for this seller, mark it dirty (so the running pass repeats once
   * more) and await that same pass instead of starting a redundant read+persist.
   * Otherwise start the loop. Net effect: a burst of N writes to one seller does
   * at most two recomputes (the in-flight one + one trailing pass that sweeps up
   * everything that landed mid-run), not N. No update can be lost: the dirty-flag
   * check and the in-flight teardown run synchronously together (no await between
   * them), so a write arriving during the compute always re-triggers the loop.
   */
  private async recomputeAggregate(subject: Types.ObjectId): Promise<void> {
    const key = String(subject);
    const existing = this.recomputeInFlight.get(key);
    if (existing !== undefined) {
      this.recomputeDirty.add(key);
      return existing;
    }
    const run = this.runRecomputeLoop(subject, key);
    this.recomputeInFlight.set(key, run);
    return run;
  }

  /** Drive computeAndPersistAggregate, re-running while writes keep arriving. */
  private async runRecomputeLoop(subject: Types.ObjectId, key: string): Promise<void> {
    try {
      do {
        this.recomputeDirty.delete(key);
        await this.computeAndPersistAggregate(subject);
      } while (this.recomputeDirty.has(key));
    } finally {
      this.recomputeInFlight.delete(key);
      this.recomputeDirty.delete(key);
    }
  }

  /** Recompute + persist a seller's aggregate from their active reviews. */
  private async computeAndPersistAggregate(subject: Types.ObjectId): Promise<void> {
    const reviews = await this.reviewModel
      .find({ subjectUserId: subject, status: 'active' })
      .select('rating')
      .lean<Array<{ rating: number }>>()
      .exec();
    const count = reviews.length;
    const sum = reviews.reduce((s, r) => s + r.rating, 0);
    const positive = reviews.filter((r) => r.rating >= POSITIVE_THRESHOLD).length;
    const ratingAvg = count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
    await this.sellerRatingModel
      .updateOne(
        { subjectUserId: subject },
        {
          $set: {
            ratingCount: count,
            ratingAvg,
            positiveCount: positive,
            wilsonScore: this.wilson(positive, count),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  /** Wilson score interval lower bound at z=1.96 (0 when no ratings). */
  private wilson(positive: number, n: number): number {
    if (n === 0) return 0;
    const p = positive / n;
    const z2 = WILSON_Z * WILSON_Z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return (centre - margin) / denom;
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }
}
