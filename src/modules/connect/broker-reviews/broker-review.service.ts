import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BrokerReview,
  type BrokerReviewDocument,
  type BrokerReviewerRole,
  type BrokerReviewVisibility,
} from './schemas/broker-review.schema';
import { BrokerRating, type BrokerRatingDocument } from './schemas/broker-rating.schema';
import { Introduction } from '../introductions/schemas/introduction.schema';
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
import { User } from '../../users/schemas/user.schema';
import type { UpsertBrokerReviewDto } from './dto/broker-review.dto';

/** The public-facing rating aggregate for a broker. */
export interface BrokerRatingAggregate {
  ratingAvg: number;
  ratingCount: number;
}

/**
 * One anonymized (or named, if opted-in) review card on the public broker
 * profile. NEVER carries `reviewerUserId`. `name` is present ONLY for a `named`
 * review; for anonymous reviews `initials` / `role` / `city` describe the
 * reviewer without identifying them (and `city` is dropped under thin-market
 * coarsening).
 */
export interface PublicBrokerReviewCard {
  _id: string;
  rating: number;
  text?: string;
  /** Always true — every broker review is anchored to a confirmed introduction. */
  verifiedIntroduction: true;
  role: BrokerReviewerRole;
  /** Present only when `visibility === 'named'`. */
  name?: string;
  /** Present only for anonymous cards (initials of the reviewer's name). */
  initials?: string;
  /** Present only for anonymous cards, and dropped when the (role, city) tuple
   *  is unique within this broker's card set (thin-market coarsening, AG8). */
  city?: string;
  brokerReply?: { text: string; repliedAt: Date } | null;
  createdAt?: Date;
}

/** The proof-led aggregate + anonymized cards a profile visitor sees. */
export interface PublicBrokerProfile {
  aggregate: {
    /** Live count of the broker's CONFIRMED, non-deleted introductions. */
    introductionsConfirmed: number;
    /** Distinct participant count across those confirmed introductions. */
    distinctPeople: number;
    ratingCount: number;
    ratingAvg: number;
    /** Every review is anchored to a confirmed introduction, so this is 100. */
    verifiedReviewRatio: number;
  };
  reviews: PublicBrokerReviewCard[];
}

/** Upper bound on the public card list — DoS backstop (mirrors LIST_HARD_CAP). */
const LIST_HARD_CAP = 200;
/** Wilson z-score (95% confidence) for the quality lower bound. */
const WILSON_Z = 1.96;
/** A rating at or above this is a Wilson "positive". */
const POSITIVE_THRESHOLD = 4;

/**
 * `BrokerReviewService` — verified-but-anonymous broker reviews anchored to a
 * CONFIRMED introduction (Broker Reviews slice).
 *
 * Primary template: `ReviewService` (`reviews/review.service.ts`) — upsert /
 * remove / own-read, the COALESCED denormalized-aggregate recompute
 * (`recomputeAggregate` / `runRecomputeLoop` / `computeAndPersistAggregate`),
 * and the Wilson score. Also mirrors `IntroductionService`'s `toObjectId` +
 * party-gate stance (the introduction is the trust anchor; a bad write must
 * surface a typed Nest exception).
 *
 * Security spec (enforced below):
 *   - a review is allowed ONLY for a party of a CONFIRMED, non-deleted
 *     introduction; `brokerUserId` is DERIVED from that introduction (never from
 *     the request body);
 *   - one review per (reviewer, introduction);
 *   - the broker (subject) can NEVER edit/delete/hide — only post ONE reply;
 *   - the reviewer withdraws via soft-delete; the public payload never leaks a
 *     reviewer id, and never a name for an anonymous review (with thin-market
 *     coarsening dropping a unique (role, city) tuple's city).
 */
@Injectable()
export class BrokerReviewService {
  constructor(
    @InjectModel(BrokerReview.name)
    private readonly brokerReviewModel: Model<BrokerReviewDocument>,
    @InjectModel(BrokerRating.name)
    private readonly brokerRatingModel: Model<BrokerRatingDocument>,
    @InjectModel(Introduction.name)
    private readonly introductionModel: Model<Introduction>,
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  /**
   * Per-broker coalescing state for the denormalized-aggregate recompute. Copied
   * verbatim from `ReviewService`: a burst of N writes to one broker collapses
   * onto one in-flight recompute (plus at most one trailing pass).
   */
  private readonly recomputeInFlight = new Map<string, Promise<void>>();
  private readonly recomputeDirty = new Set<string>();

  // ── Write: upsert ──────────────────────────────────────────────────────────

  /**
   * Create or edit the caller's review of a broker, anchored to a CONFIRMED
   * introduction. Guards (the security spec):
   *   - the introduction must exist, be `confirmed`, and NOT soft-deleted;
   *   - the caller must be a PARTY of it (`userLow` or `userHigh`), else Forbidden;
   *   - `brokerUserId` is DERIVED from the introduction (body cannot forge it);
   *   - `reviewerRoleAtIntro` is DERIVED from the introduction's `roleOfLow`.
   * Then upserts one review per (reviewer, introduction) + recomputes the
   * broker's aggregate.
   */
  async upsertReview(
    reviewerUserId: string | Types.ObjectId,
    dto: UpsertBrokerReviewDto,
  ): Promise<BrokerReviewDocument> {
    const reviewer = this.toObjectId(reviewerUserId);
    const introId = this.toObjectId(dto.introductionId);

    // Load the anchoring introduction — must be confirmed + live + the caller a party.
    const intro = await this.introductionModel
      .findOne({ _id: introId, status: 'confirmed', deletedAt: { $in: [null, undefined] } })
      .select('brokerUserId userLow userHigh roleOfLow')
      .lean<{
        brokerUserId: Types.ObjectId;
        userLow: Types.ObjectId;
        userHigh: Types.ObjectId;
        roleOfLow: BrokerReviewerRole;
      } | null>()
      .exec();
    if (!intro) {
      throw new ForbiddenException('You can only review a broker for a confirmed introduction.');
    }

    const isLow = new Types.ObjectId(intro.userLow).equals(reviewer);
    const isHigh = new Types.ObjectId(intro.userHigh).equals(reviewer);
    if (!isLow && !isHigh) {
      throw new ForbiddenException('Only a party of this introduction can review the broker.');
    }

    // Derive the broker FROM the introduction — never trust a body-supplied id.
    const broker = new Types.ObjectId(intro.brokerUserId);
    // A broker is never a party (the create guard bars it), but assert defensively.
    if (broker.equals(reviewer)) {
      throw new ForbiddenException('You cannot review yourself.');
    }

    // Derive the reviewer's role: the low party holds `roleOfLow`, the high party
    // holds the opposite.
    const reviewerRoleAtIntro: BrokerReviewerRole = isLow
      ? intro.roleOfLow
      : this.oppositeRole(intro.roleOfLow);

    // Snapshot the reviewer's city from their ConnectProfile (free-text `geoCity`,
    // falling back to the free-text `district` hub). Snapshotted so a later
    // profile edit cannot retroactively re-identify a thin-market card.
    const reviewerCitySnapshot = await this.snapshotCity(reviewer);

    const visibility: BrokerReviewVisibility = dto.visibility ?? 'anonymous';

    // Upsert one review per (reviewer, introduction). The broker / role / status /
    // brokerReply / deletedAt are NEVER set from a re-submit's body — broker +
    // role are derived (set on insert) and the broker-only fields are untouched.
    const review = await this.brokerReviewModel
      .findOneAndUpdate(
        { reviewerUserId: reviewer, introductionId: introId },
        {
          $set: {
            rating: dto.rating,
            text: dto.text?.trim() ?? '',
            visibility,
            reviewerCitySnapshot: reviewerCitySnapshot ?? '',
          },
          $setOnInsert: {
            brokerUserId: broker,
            reviewerRoleAtIntro,
            status: 'active',
            brokerReply: null,
            deletedAt: null,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.recomputeAggregate(broker);
    return review;
  }

  // ── Write: broker reply ──────────────────────────────────────────────────────

  /**
   * The broker posts their single reply to a review. ONLY the review's
   * `brokerUserId` (the subject) may reply — a reviewer or anyone else is
   * Forbidden. The reply can be set ONCE (a second attempt is Forbidden). The
   * broker may NEVER change rating / text / visibility / status / deletedAt:
   * this method touches `brokerReply` only.
   */
  async replyToReview(
    brokerUserId: string | Types.ObjectId,
    reviewId: string,
    text: string,
  ): Promise<BrokerReviewDocument> {
    const broker = this.toObjectId(brokerUserId);
    const review = await this.loadLive(reviewId);

    if (!new Types.ObjectId(review.brokerUserId).equals(broker)) {
      throw new ForbiddenException('Only the reviewed broker can reply to this review.');
    }
    if (review.brokerReply) {
      throw new ForbiddenException('You have already replied to this review.');
    }

    review.brokerReply = { text: text.trim(), repliedAt: new Date() };
    await review.save();
    return review;
  }

  // ── Write: reviewer withdraw ─────────────────────────────────────────────────

  /**
   * The original reviewer withdraws their review (soft-delete, never hard-delete).
   * ONLY the `reviewerUserId` may withdraw. Recomputes the broker's aggregate.
   */
  async withdrawReview(reviewerUserId: string | Types.ObjectId, reviewId: string): Promise<void> {
    const reviewer = this.toObjectId(reviewerUserId);
    const review = await this.loadLive(reviewId);

    if (!new Types.ObjectId(review.reviewerUserId).equals(reviewer)) {
      throw new ForbiddenException('Only the reviewer can withdraw this review.');
    }

    review.deletedAt = new Date();
    await review.save();
    await this.recomputeAggregate(new Types.ObjectId(review.brokerUserId));
  }

  // ── Read: own review ─────────────────────────────────────────────────────────

  /** The caller's own review for an introduction (drives the edit form), or null. */
  async getMyReview(
    reviewerUserId: string | Types.ObjectId,
    introductionId: string,
  ): Promise<BrokerReviewDocument | null> {
    if (!Types.ObjectId.isValid(introductionId)) return null;
    return this.brokerReviewModel
      .findOne({
        reviewerUserId: this.toObjectId(reviewerUserId),
        introductionId: new Types.ObjectId(introductionId),
        deletedAt: { $in: [null, undefined] },
      })
      .exec();
  }

  // ── Read: public broker profile (leak-safe) ──────────────────────────────────

  /**
   * The profile-visitor payload: a proof-led aggregate + anonymized review cards.
   * Leak-safe by construction — a card NEVER carries `reviewerUserId`, and a name
   * appears ONLY for a `named` review. Thin-market coarsening (AG8) drops the
   * `city` from any anonymous card whose (role, city) tuple maps to exactly one
   * reviewer in this broker's card set.
   */
  async getPublicBrokerProfile(brokerUserId: string): Promise<PublicBrokerProfile> {
    const empty: PublicBrokerProfile = {
      aggregate: {
        introductionsConfirmed: 0,
        distinctPeople: 0,
        ratingCount: 0,
        ratingAvg: 0,
        verifiedReviewRatio: 100,
      },
      reviews: [],
    };
    if (!Types.ObjectId.isValid(brokerUserId)) return empty;
    const broker = new Types.ObjectId(brokerUserId);

    // Proof counts — live from the Introduction collection (not stored on the
    // rating aggregate): confirmed, non-deleted introductions + distinct people.
    const confirmedIntros = await this.introductionModel
      .find({ brokerUserId: broker, status: 'confirmed', deletedAt: { $in: [null, undefined] } })
      .select('userLow userHigh')
      .lean<Array<{ userLow: Types.ObjectId; userHigh: Types.ObjectId }>>()
      .exec();
    const introductionsConfirmed = confirmedIntros.length;
    const peopleSet = new Set<string>();
    for (const i of confirmedIntros) {
      peopleSet.add(String(i.userLow));
      peopleSet.add(String(i.userHigh));
    }

    const ratingRow = await this.brokerRatingModel
      .findOne({ brokerUserId: broker })
      .select('ratingAvg ratingCount')
      .lean<{ ratingAvg: number; ratingCount: number } | null>()
      .exec();

    // The active, non-deleted review docs (newest first). Reviewer name is fetched
    // ONLY for named reviews (below), never for anonymous ones.
    const reviews = await this.brokerReviewModel
      .find({ brokerUserId: broker, status: 'active', deletedAt: { $in: [null, undefined] } })
      .sort({ createdAt: -1 })
      .limit(LIST_HARD_CAP)
      .select(
        'reviewerUserId rating text visibility reviewerRoleAtIntro reviewerCitySnapshot brokerReply createdAt',
      )
      .lean<
        Array<{
          _id: Types.ObjectId;
          reviewerUserId: Types.ObjectId;
          rating: number;
          text?: string;
          visibility: BrokerReviewVisibility;
          reviewerRoleAtIntro: BrokerReviewerRole;
          reviewerCitySnapshot?: string;
          brokerReply?: { text: string; repliedAt: Date } | null;
          createdAt?: Date;
        }>
      >()
      .exec();

    // Resolve reviewer names in ONE batched read — used to render the full `name`
    // ONLY on `named` cards, and to derive `initials` (a non-identifying digest,
    // e.g. "R.P.") on anonymous cards. A name is NEVER placed on an anonymous
    // card; the map is an internal lookup, not part of any card payload.
    const reviewerIds = reviews.map((r) => new Types.ObjectId(r.reviewerUserId));
    const nameById = new Map<string, string>();
    if (reviewerIds.length > 0) {
      const reviewerUsers = await this.userModel
        .find({ _id: { $in: reviewerIds } })
        .select('name')
        .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
        .exec();
      for (const u of reviewerUsers) nameById.set(String(u._id), u.name ?? '');
    }

    // Thin-market coarsening (AG8): a (role, city) tuple that maps to exactly ONE
    // distinct reviewer within this broker's ANONYMOUS card set must drop its city
    // (so a single buyer-from-Surat card can't be re-identified). Count distinct
    // reviewers per (role, city) over anonymous, city-bearing cards.
    const tupleReviewers = new Map<string, Set<string>>();
    for (const r of reviews) {
      if (r.visibility !== 'anonymous') continue;
      const city = (r.reviewerCitySnapshot ?? '').trim();
      if (!city) continue;
      const key = `${r.reviewerRoleAtIntro}::${city.toLowerCase()}`;
      let set = tupleReviewers.get(key);
      if (!set) {
        set = new Set<string>();
        tupleReviewers.set(key, set);
      }
      set.add(String(r.reviewerUserId));
    }

    const cards: PublicBrokerReviewCard[] = reviews.map((r) => {
      const base: PublicBrokerReviewCard = {
        _id: String(r._id),
        rating: r.rating,
        text: r.text || undefined,
        verifiedIntroduction: true,
        role: r.reviewerRoleAtIntro,
        brokerReply: r.brokerReply ?? null,
        createdAt: r.createdAt,
      };
      if (r.visibility === 'named') {
        // Named opt-in: show the reviewer's name. Never include initials/city.
        const name = nameById.get(String(r.reviewerUserId));
        if (name) base.name = name;
        return base;
      }
      // Anonymous: NEVER a name/id. Initials from the reviewer's name; city only
      // when the (role, city) tuple is NOT unique (coarsening).
      base.initials = this.initialsFor(nameById.get(String(r.reviewerUserId)));
      const city = (r.reviewerCitySnapshot ?? '').trim();
      if (city) {
        const key = `${r.reviewerRoleAtIntro}::${city.toLowerCase()}`;
        const distinct = tupleReviewers.get(key)?.size ?? 0;
        if (distinct > 1) base.city = city;
      }
      return base;
    });

    return {
      aggregate: {
        introductionsConfirmed,
        distinctPeople: peopleSet.size,
        ratingCount: ratingRow?.ratingCount ?? 0,
        ratingAvg: ratingRow?.ratingAvg ?? 0,
        verifiedReviewRatio: 100,
      },
      reviews: cards,
    };
  }

  // ── Aggregate recompute (coalesced — copied from ReviewService) ───────────────

  /**
   * The display aggregate for one broker (zeros when unrated). Public read helper
   * mirroring `ReviewService.getAggregate`.
   */
  async getAggregate(brokerUserId: string): Promise<BrokerRatingAggregate> {
    if (!Types.ObjectId.isValid(brokerUserId)) return { ratingAvg: 0, ratingCount: 0 };
    const row = await this.brokerRatingModel
      .findOne({ brokerUserId: new Types.ObjectId(brokerUserId) })
      .select('ratingAvg ratingCount')
      .lean<{ ratingAvg: number; ratingCount: number } | null>()
      .exec();
    return { ratingAvg: row?.ratingAvg ?? 0, ratingCount: row?.ratingCount ?? 0 };
  }

  /**
   * Coalesce the aggregate recompute for a broker — identical strategy to
   * `ReviewService.recomputeAggregate`: a burst of N writes to one broker does at
   * most two recomputes (the in-flight one + one trailing pass), never N. No
   * update is lost (the dirty-flag check + in-flight teardown run synchronously).
   */
  async recomputeAggregate(broker: Types.ObjectId): Promise<void> {
    const key = String(broker);
    const existing = this.recomputeInFlight.get(key);
    if (existing !== undefined) {
      this.recomputeDirty.add(key);
      return existing;
    }
    const run = this.runRecomputeLoop(broker, key);
    this.recomputeInFlight.set(key, run);
    return run;
  }

  /** Drive computeAndPersistAggregate, re-running while writes keep arriving. */
  private async runRecomputeLoop(broker: Types.ObjectId, key: string): Promise<void> {
    try {
      do {
        this.recomputeDirty.delete(key);
        await this.computeAndPersistAggregate(broker);
      } while (this.recomputeDirty.has(key));
    } finally {
      this.recomputeInFlight.delete(key);
      this.recomputeDirty.delete(key);
    }
  }

  /** Recompute + persist a broker's aggregate from their active, live reviews. */
  private async computeAndPersistAggregate(broker: Types.ObjectId): Promise<void> {
    const reviews = await this.brokerReviewModel
      .find({ brokerUserId: broker, status: 'active', deletedAt: { $in: [null, undefined] } })
      .select('rating')
      .lean<Array<{ rating: number }>>()
      .exec();
    const count = reviews.length;
    const sum = reviews.reduce((s, r) => s + r.rating, 0);
    const positive = reviews.filter((r) => r.rating >= POSITIVE_THRESHOLD).length;
    const ratingAvg = count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
    await this.brokerRatingModel
      .updateOne(
        { brokerUserId: broker },
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

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Load a live (not soft-deleted) review doc for mutate + save, or 404. */
  private async loadLive(reviewId: string): Promise<BrokerReviewDocument> {
    if (!Types.ObjectId.isValid(reviewId)) throw new NotFoundException('Review not found.');
    const review = await this.brokerReviewModel
      .findOne({ _id: new Types.ObjectId(reviewId), deletedAt: { $in: [null, undefined] } })
      .exec();
    if (!review) throw new NotFoundException('Review not found.');
    return review;
  }

  /**
   * Snapshot the reviewer's city: prefer the structured free-text `geoCity`, then
   * the free-text `district` textile hub (both on `ConnectProfile`). Empty when
   * the member set neither.
   */
  private async snapshotCity(reviewer: Types.ObjectId): Promise<string | undefined> {
    const profile = await this.profileModel
      .findOne({ userId: reviewer })
      .select('geoCity district')
      .lean<{ geoCity?: string; district?: string } | null>()
      .exec();
    const city = (profile?.geoCity ?? '').trim() || (profile?.district ?? '').trim();
    return city ? city : undefined;
  }

  /** Initials from a display name (e.g. "Ravi Patel" -> "R.P."). Empty -> "". */
  private initialsFor(name?: string): string {
    if (!name) return '';
    const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (parts.length === 0) return '';
    return parts.map((p) => `${p[0].toUpperCase()}.`).join('');
  }

  /** The opposite buyer/seller role. */
  private oppositeRole(role: BrokerReviewerRole): BrokerReviewerRole {
    return role === 'buyer' ? 'seller' : 'buyer';
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }
}
