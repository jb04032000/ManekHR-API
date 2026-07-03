/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { BadRequestException } from '@nestjs/common';
import { ReviewService } from '../review.service';

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

describe('ReviewService (marketplace Phase C)', () => {
  let reviewModel: any;
  let sellerRatingModel: any;
  const reviewer = new Types.ObjectId();
  const subject = new Types.ObjectId();

  function build() {
    return new ReviewService(reviewModel, sellerRatingModel);
  }

  beforeEach(() => {
    reviewModel = {
      findOneAndUpdate: vi.fn(() => chain({ _id: new Types.ObjectId(), rating: 5 })),
      deleteOne: vi.fn(() => chain({ deletedCount: 1 })),
      findOne: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
      updateOne: vi.fn(() => chain({ matchedCount: 1 })),
      // The first-page star-distribution $group (score bars).
      aggregate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue([]) })),
    };
    sellerRatingModel = {
      updateOne: vi.fn(() => chain({})),
      findOne: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
    };
  });

  it('blocks a self-review', async () => {
    await expect(
      build().upsert(reviewer, { subjectUserId: String(reviewer), rating: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reviewModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upserts the review and recomputes the aggregate (avg + Wilson)', async () => {
    // Recompute reads back the subject's active reviews.
    reviewModel.find = vi.fn(() => chain([{ rating: 5 }, { rating: 4 }]));
    await build().upsert(reviewer, { subjectUserId: String(subject), rating: 5 });

    expect(reviewModel.findOneAndUpdate).toHaveBeenCalled();
    expect(sellerRatingModel.updateOne).toHaveBeenCalled();
    const set = sellerRatingModel.updateOne.mock.calls[0][1].$set;
    expect(set.ratingCount).toBe(2);
    expect(set.ratingAvg).toBe(4.5);
    expect(set.positiveCount).toBe(2);
    expect(set.wilsonScore).toBeGreaterThan(0);
    expect(set.wilsonScore).toBeLessThanOrEqual(1);
  });

  it('coalesces rapid writes to one subject: N concurrent writes do fewer than N recomputes, final aggregate correct', async () => {
    // The recompute reads back the subject's active reviews; the final, settled
    // state is three reviews (count 3, avg 4.7). Every recompute sees the same
    // mocked set, so the persisted aggregate is the correct settled value.
    reviewModel.find = vi.fn(() => chain([{ rating: 5 }, { rating: 5 }, { rating: 4 }]));
    const svc = build();

    // Five rapid writes to the SAME seller, fired concurrently (the realistic
    // burst shape). They overlap on the per-subject in-flight recompute and
    // collapse onto far fewer read+persist cycles.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.upsert(reviewer, { subjectUserId: String(subject), rating: 5 }),
      ),
    );

    // Fewer persists than writes (coalesced to the in-flight pass + one trailing).
    expect(sellerRatingModel.updateOne.mock.calls.length).toBeLessThan(5);
    expect(sellerRatingModel.updateOne.mock.calls.length).toBeGreaterThan(0);

    // The LAST persisted aggregate is the correct settled value.
    const lastSet =
      sellerRatingModel.updateOne.mock.calls[sellerRatingModel.updateOne.mock.calls.length - 1][1]
        .$set;
    expect(lastSet.ratingCount).toBe(3);
    expect(lastSet.ratingAvg).toBe(4.7);
  });

  it('Wilson resists small-sample inflation: 4.6-over-many beats a single 5-star', () => {
    const svc: any = build();
    const manyFour = svc.wilson(46, 50); // 46/50 positives
    const oneFive = svc.wilson(1, 1); // a single 5-star
    expect(manyFour).toBeGreaterThan(oneFive);
  });

  it('getAggregate returns zeros for an unrated seller', async () => {
    sellerRatingModel.findOne = vi.fn(() => chain(null));
    expect(await build().getAggregate(String(subject))).toEqual({ ratingAvg: 0, ratingCount: 0 });
  });

  it('getAggregatesFor returns only rated sellers, keyed by id', async () => {
    sellerRatingModel.find = vi.fn(() =>
      chain([{ subjectUserId: subject, ratingAvg: 4.3, ratingCount: 7 }]),
    );
    const map = await build().getAggregatesFor([String(subject)]);
    expect(map.get(String(subject))).toEqual({ ratingAvg: 4.3, ratingCount: 7 });
  });

  it('lists a seller reviews with the aggregate', async () => {
    reviewModel.find = vi.fn(() => chain([{ _id: new Types.ObjectId(), rating: 5 }]));
    sellerRatingModel.findOne = vi.fn(() => chain({ ratingAvg: 5, ratingCount: 1 }));
    const page = await build().listForSeller(String(subject));
    expect(page.reviews).toHaveLength(1);
    expect(page.aggregate).toEqual({ ratingAvg: 5, ratingCount: 1 });
  });

  it('first page carries the star distribution; cursor pages omit it', async () => {
    reviewModel.find = vi.fn(() => chain([{ _id: new Types.ObjectId(), rating: 5 }]));
    reviewModel.aggregate = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue([
        { _id: 5, count: 21 },
        { _id: 4, count: 5 },
        { _id: 3, count: 2 },
      ]),
    }));
    const first = await build().listForSeller(String(subject));
    expect(first.distribution).toEqual({ '1': 0, '2': 0, '3': 2, '4': 5, '5': 21 });

    const next = await build().listForSeller(String(subject), new Date().toISOString());
    expect(next.distribution).toBeUndefined();
  });
});
