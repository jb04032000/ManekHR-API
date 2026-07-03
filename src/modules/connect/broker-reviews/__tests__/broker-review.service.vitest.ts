/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema imports don't trip vitest's reflect-metadata pipeline
// (see introduction.service.vitest.ts / review.service.vitest.ts for the pattern).
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types } from 'mongoose';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BrokerReviewService } from '../broker-review.service';

/** A chainable query mock resolving to `result` (mirrors review.service.vitest). */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    populate: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

describe('BrokerReviewService (verified-but-anonymous broker reviews)', () => {
  let brokerReviewModel: any;
  let brokerRatingModel: any;
  let introductionModel: any;
  let profileModel: any;
  let userModel: any;

  // Known-ordering ids: low < high (hex). broker is a third party.
  const broker = new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
  const low = new Types.ObjectId('111111111111111111111111');
  const high = new Types.ObjectId('999999999999999999999999');
  const introId = new Types.ObjectId('555555555555555555555555');

  function build() {
    return new BrokerReviewService(
      brokerReviewModel,
      brokerRatingModel,
      introductionModel,
      profileModel,
      userModel,
    );
  }

  /** A confirmed, live introduction (broker + low=seller party). */
  function confirmedIntro(over: Partial<any> = {}) {
    return {
      _id: introId,
      brokerUserId: broker,
      userLow: low,
      userHigh: high,
      roleOfLow: 'seller',
      ...over,
    };
  }

  beforeEach(() => {
    brokerReviewModel = {
      findOne: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
      findOneAndUpdate: vi.fn(() => chain({ _id: new Types.ObjectId() })),
      updateOne: vi.fn(() => chain({})),
    };
    brokerRatingModel = {
      findOne: vi.fn(() => chain(null)),
      updateOne: vi.fn(() => chain({})),
    };
    introductionModel = {
      findOne: vi.fn(() => chain(confirmedIntro())),
      find: vi.fn(() => chain([])),
    };
    profileModel = { findOne: vi.fn(() => chain({ geoCity: 'Surat' })) };
    userModel = { find: vi.fn(() => chain([])) };
  });

  // ── upsertReview: party + confirmed-intro gate ───────────────────────────────

  it('upsert: rejects when the introduction is not confirmed/live (Forbidden)', async () => {
    introductionModel.findOne = vi.fn(() => chain(null)); // findOne filters on status:confirmed
    await expect(
      build().upsertReview(low, { introductionId: String(introId), rating: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(brokerReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upsert: only filters for confirmed + non-deleted introductions', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 5 });
    const filter = introductionModel.findOne.mock.calls[0][0];
    expect(filter.status).toBe('confirmed');
    expect(filter.deletedAt).toEqual({ $in: [null, undefined] });
  });

  it('upsert: rejects a caller who is NOT a party of the introduction (Forbidden)', async () => {
    const stranger = new Types.ObjectId('222222222222222222222222');
    await expect(
      build().upsertReview(stranger, { introductionId: String(introId), rating: 4 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(brokerReviewModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upsert: derives brokerUserId FROM the introduction (body cannot forge it)', async () => {
    await build().upsertReview(low, {
      introductionId: String(introId),
      rating: 5,
      // Note: no broker id in the DTO at all — it is derived.
    } as any);
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    expect(String(update.$setOnInsert.brokerUserId)).toBe(String(broker));
  });

  it('upsert: derives reviewerRoleAtIntro = roleOfLow when caller is the low party', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 5 });
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert.reviewerRoleAtIntro).toBe('seller'); // low holds roleOfLow
  });

  it('upsert: derives reviewerRoleAtIntro = OPPOSITE when caller is the high party', async () => {
    await build().upsertReview(high, { introductionId: String(introId), rating: 5 });
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert.reviewerRoleAtIntro).toBe('buyer'); // high holds the opposite
  });

  it('upsert: one review per (reviewer, introduction) — filter keyed on both', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 5 });
    const filter = brokerReviewModel.findOneAndUpdate.mock.calls[0][0];
    expect(String(filter.reviewerUserId)).toBe(String(low));
    expect(String(filter.introductionId)).toBe(String(introId));
    const opts = brokerReviewModel.findOneAndUpdate.mock.calls[0][2];
    expect(opts.upsert).toBe(true);
  });

  it('upsert: snapshots the reviewer city + defaults visibility to anonymous', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 5 });
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.reviewerCitySnapshot).toBe('Surat');
    expect(update.$set.visibility).toBe('anonymous');
  });

  it('upsert: honors a named visibility opt-in', async () => {
    await build().upsertReview(low, {
      introductionId: String(introId),
      rating: 5,
      visibility: 'named',
    });
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.visibility).toBe('named');
  });

  it('upsert: never sets broker-only fields from the body (status/reply/deletedAt only on insert)', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 3 });
    const update = brokerReviewModel.findOneAndUpdate.mock.calls[0][1];
    // The editable $set carries ONLY reviewer-owned fields.
    expect(Object.keys(update.$set).sort()).toEqual(
      ['rating', 'reviewerCitySnapshot', 'text', 'visibility'].sort(),
    );
    // status / brokerReply / deletedAt are insert-only (broker can't be reset by a re-submit).
    expect(update.$setOnInsert.status).toBe('active');
    expect(update.$setOnInsert.brokerReply).toBeNull();
    expect(update.$setOnInsert.deletedAt).toBeNull();
  });

  it('upsert: recomputes the broker aggregate after the write', async () => {
    await build().upsertReview(low, { introductionId: String(introId), rating: 5 });
    expect(brokerRatingModel.updateOne).toHaveBeenCalled();
  });

  // ── replyToReview: broker-only, once ─────────────────────────────────────────

  /** A live review doc with a working save(). */
  function reviewDoc(over: Partial<any> = {}) {
    const doc: any = {
      _id: new Types.ObjectId(),
      brokerUserId: broker,
      reviewerUserId: low,
      rating: 5,
      status: 'active',
      brokerReply: null,
      deletedAt: null,
      ...over,
    };
    doc.save = vi.fn().mockResolvedValue(doc);
    return doc;
  }

  it('reply: only the reviewed broker may reply (a reviewer is Forbidden)', async () => {
    const doc = reviewDoc();
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(build().replyToReview(low, String(doc._id), 'thanks')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('reply: the broker may reply once + only brokerReply is mutated', async () => {
    const doc = reviewDoc();
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().replyToReview(broker, String(doc._id), '  glad to help  ');
    expect(doc.brokerReply.text).toBe('glad to help'); // trimmed
    expect(doc.brokerReply.repliedAt).toBeInstanceOf(Date);
    // The broker cannot have changed rating/status/deletedAt — untouched.
    expect(doc.rating).toBe(5);
    expect(doc.status).toBe('active');
    expect(doc.deletedAt).toBeNull();
    expect(doc.save).toHaveBeenCalled();
  });

  it('reply: a second reply is Forbidden (reply is once-only)', async () => {
    const doc = reviewDoc({ brokerReply: { text: 'first', repliedAt: new Date() } });
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(build().replyToReview(broker, String(doc._id), 'second')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('reply: 404 for a missing / soft-deleted review', async () => {
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await expect(
      build().replyToReview(broker, String(new Types.ObjectId()), 'hi'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── withdrawReview: reviewer-only soft-delete ────────────────────────────────

  it('withdraw: only the reviewer may withdraw (the broker is Forbidden)', async () => {
    const doc = reviewDoc();
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(build().withdrawReview(broker, String(doc._id))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('withdraw: the reviewer soft-deletes (deletedAt set) + recomputes', async () => {
    const doc = reviewDoc();
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().withdrawReview(low, String(doc._id));
    expect(doc.deletedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
    expect(brokerRatingModel.updateOne).toHaveBeenCalled(); // recompute
  });

  // ── aggregate math ───────────────────────────────────────────────────────────

  it('recompute: persists count, 1-decimal avg, positive count from active reviews', async () => {
    brokerReviewModel.find = vi.fn(() => chain([{ rating: 5 }, { rating: 4 }, { rating: 2 }]));
    await build().recomputeAggregate(broker);
    const update = brokerRatingModel.updateOne.mock.calls[0][1];
    expect(update.$set.ratingCount).toBe(3);
    expect(update.$set.ratingAvg).toBe(3.7); // (5+4+2)/3 = 3.666 -> 3.7
    expect(update.$set.positiveCount).toBe(2); // ratings >= 4
    expect(update.$set.wilsonScore).toBeGreaterThan(0);
  });

  it('recompute: zeros when a broker has no active reviews', async () => {
    brokerReviewModel.find = vi.fn(() => chain([]));
    await build().recomputeAggregate(broker);
    const update = brokerRatingModel.updateOne.mock.calls[0][1];
    expect(update.$set.ratingCount).toBe(0);
    expect(update.$set.ratingAvg).toBe(0);
    expect(update.$set.wilsonScore).toBe(0);
  });

  // ── getMyReview ──────────────────────────────────────────────────────────────

  it('getMyReview: scopes to the caller + introduction, excludes deleted', async () => {
    brokerReviewModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await build().getMyReview(low, String(introId));
    const filter = brokerReviewModel.findOne.mock.calls[0][0];
    expect(String(filter.reviewerUserId)).toBe(String(low));
    expect(String(filter.introductionId)).toBe(String(introId));
    expect(filter.deletedAt).toEqual({ $in: [null, undefined] });
  });

  // ── getPublicBrokerProfile: leak safety + coarsening + proof counts ───────────

  it('public: aggregate carries live confirmed-intro + distinct-people proof counts', async () => {
    introductionModel.find = vi.fn(() =>
      chain([
        { userLow: low, userHigh: high },
        { userLow: low, userHigh: new Types.ObjectId('333333333333333333333333') },
      ]),
    );
    brokerRatingModel.findOne = vi.fn(() => chain({ ratingAvg: 4.5, ratingCount: 2 }));
    brokerReviewModel.find = vi.fn(() => chain([]));
    const out = await build().getPublicBrokerProfile(String(broker));
    expect(out.aggregate.introductionsConfirmed).toBe(2);
    // distinct participants across both intros: low, high, third = 3
    expect(out.aggregate.distinctPeople).toBe(3);
    expect(out.aggregate.ratingAvg).toBe(4.5);
    expect(out.aggregate.ratingCount).toBe(2);
    expect(out.aggregate.verifiedReviewRatio).toBe(100);
  });

  it('public: NEVER leaks reviewerUserId and shows NO name for anonymous reviews', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    brokerRatingModel.findOne = vi.fn(() => chain(null));
    brokerReviewModel.find = vi.fn(() =>
      chain([
        {
          _id: new Types.ObjectId(),
          reviewerUserId: low,
          rating: 5,
          text: 'great broker',
          visibility: 'anonymous',
          reviewerRoleAtIntro: 'buyer',
          reviewerCitySnapshot: 'Surat',
          brokerReply: null,
          createdAt: new Date(),
        },
      ]),
    );
    userModel.find = vi.fn(() => chain([{ _id: low, name: 'Ravi Patel' }]));
    const out = await build().getPublicBrokerProfile(String(broker));
    const card = out.reviews[0] as any;
    expect(card.reviewerUserId).toBeUndefined();
    expect(card.name).toBeUndefined(); // anonymous -> no name
    expect(card.initials).toBe('R.P.'); // initials, not the name
    expect(card.role).toBe('buyer');
    expect(card.verifiedIntroduction).toBe(true);
  });

  it('public: a NAMED review shows the reviewer name (no initials/city)', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    brokerRatingModel.findOne = vi.fn(() => chain(null));
    brokerReviewModel.find = vi.fn(() =>
      chain([
        {
          _id: new Types.ObjectId(),
          reviewerUserId: high,
          rating: 4,
          visibility: 'named',
          reviewerRoleAtIntro: 'seller',
          reviewerCitySnapshot: 'Jetpur',
          brokerReply: null,
          createdAt: new Date(),
        },
      ]),
    );
    userModel.find = vi.fn(() => chain([{ _id: high, name: 'Meena Shah' }]));
    const out = await build().getPublicBrokerProfile(String(broker));
    const card = out.reviews[0] as any;
    expect(card.name).toBe('Meena Shah');
    expect(card.initials).toBeUndefined();
    expect(card.city).toBeUndefined(); // named cards carry no city
    expect(card.reviewerUserId).toBeUndefined();
  });

  it('public: thin-market coarsening drops city for a UNIQUE (role, city) tuple', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    brokerRatingModel.findOne = vi.fn(() => chain(null));
    const r1 = new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaab1');
    const r2 = new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaab2');
    const r3 = new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaab3');
    brokerReviewModel.find = vi.fn(() =>
      chain([
        // Two distinct buyers from Surat -> tuple NOT unique -> city kept.
        anonCard(r1, 'buyer', 'Surat'),
        anonCard(r2, 'buyer', 'Surat'),
        // The only seller from Rajkot -> tuple unique -> city dropped.
        anonCard(r3, 'seller', 'Rajkot'),
      ]),
    );
    userModel.find = vi.fn(() =>
      chain([
        { _id: r1, name: 'Aaa One' },
        { _id: r2, name: 'Bbb Two' },
        { _id: r3, name: 'Ccc Three' },
      ]),
    );
    const out = await build().getPublicBrokerProfile(String(broker));
    const surat = out.reviews.filter((c) => c.role === 'buyer');
    const rajkot = out.reviews.find((c) => c.role === 'seller') as any;
    expect(surat.every((c) => c.city === 'Surat')).toBe(true); // shared tuple -> kept
    expect(rajkot.city).toBeUndefined(); // unique tuple -> dropped
    expect(rajkot.initials).toBe('C.T.'); // role still rendered via initials
  });

  function anonCard(reviewerUserId: Types.ObjectId, role: string, city: string) {
    return {
      _id: new Types.ObjectId(),
      reviewerUserId,
      rating: 5,
      visibility: 'anonymous',
      reviewerRoleAtIntro: role,
      reviewerCitySnapshot: city,
      brokerReply: null,
      createdAt: new Date(),
    };
  }

  it('public: returns the empty proof payload for an invalid broker id', async () => {
    const out = await build().getPublicBrokerProfile('not-an-id');
    expect(out.reviews).toEqual([]);
    expect(out.aggregate.introductionsConfirmed).toBe(0);
    expect(out.aggregate.verifiedReviewRatio).toBe(100);
  });
});
