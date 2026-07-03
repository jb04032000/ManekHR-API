/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest';

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

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RfqService } from '../rfq.service';

const BUYER = '60e0000000000000000000a1';
const SELLER = '60e0000000000000000000a2';

function chain(result: any) {
  const o: any = {
    sort: () => o,
    skip: () => o,
    limit: () => o,
    lean: () => o,
    exec: async () => result,
  };
  return o;
}

function makeRfqModel(opts?: { findByIdDoc?: any }) {
  return {
    create: vi.fn(async (input: any) => ({ ...input, _id: 'rfq-1' })),
    find: vi.fn(() => chain([])),
    findById: vi.fn(async () => opts?.findByIdDoc ?? null),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    aggregate: vi.fn(async () => []),
    countDocuments: vi.fn(async () => 0),
    lastFind: undefined as any,
  } as any;
}

function makeQuoteModel(opts?: { existing?: any; findByIdDoc?: any }) {
  return {
    findOne: vi.fn(async () => opts?.existing ?? null),
    create: vi.fn(async (input: any) => ({ ...input, _id: 'q-1', save: vi.fn() })),
    find: vi.fn(() => chain([])),
    findById: vi.fn(async () => opts?.findByIdDoc ?? null),
    // recomputeLowestQuote ($min over live quotes) + quotedRfqIds (distinct).
    aggregate: vi.fn(async () => []),
    distinct: vi.fn(() => ({ exec: async () => [] })),
    countDocuments: vi.fn(async () => 0),
  } as any;
}

// The marketplace Listing model is read-only here: supplyCategories distinct.
function makeListingModel() {
  return { distinct: vi.fn(() => ({ exec: async () => [] })) } as any;
}

// User model is read-only: createRfq/createQuote read author.isDemo to stamp the
// denormalized isDemo flag. `demoIds` lists the user ids that resolve to demo.
function makeUserModel(demoIds: string[] = []) {
  const set = new Set(demoIds);
  return {
    findById: vi.fn((id: string) => ({
      select: () => ({
        lean: () => ({ exec: async () => ({ isDemo: set.has(id) }) }),
      }),
    })),
  } as any;
}

// TagService folds a custom category into the shared pool. normalizeHashtags
// echoes the trimmed-lowercased input (the real engine returns the input as its
// own slug when unknown); recordUsage is fire-and-forget.
function makeTagService() {
  return {
    normalizeHashtags: vi.fn(async (raw: string[]) => raw.map((s) => s.trim().toLowerCase())),
    recordUsage: vi.fn(() => Promise.resolve()),
  } as any;
}

function makeSvc(
  rfqModel: any,
  quoteModel: any,
  listingModel: any = makeListingModel(),
  tagService: any = makeTagService(),
  userModel: any = makeUserModel(),
) {
  const audit = { logEvent: vi.fn(() => Promise.resolve()) };
  const posthog = { capture: vi.fn() };
  return new RfqService(
    rfqModel,
    quoteModel,
    listingModel,
    userModel,
    audit as any,
    tagService,
    posthog as any,
    // Media-ownership guard stub (no-op pass): real ownership is covered by the
    // shared MediaOwnershipService suite; here we only need createQuote to run.
    { assertOwnedMedia: () => Promise.resolve() } as any,
  );
}

describe('RfqService', () => {
  it('createRfq persists an open request', async () => {
    const rfqModel = makeRfqModel();
    const svc = makeSvc(rfqModel, makeQuoteModel());
    const rfq = await svc.createRfq(BUYER, { title: 'Need cotton', category: 'weaving' } as any);
    expect((rfq as any).status).toBe('open');
    expect(rfqModel.create).toHaveBeenCalled();
  });

  it('createRfq normalizes a custom category through the tag pool + records usage', async () => {
    const rfqModel = makeRfqModel();
    const tagService = makeTagService();
    tagService.normalizeHashtags = vi.fn(async () => ['hand-block-print']);
    const svc = makeSvc(rfqModel, makeQuoteModel(), makeListingModel(), tagService);
    await svc.createRfq(BUYER, { title: 'Need printing', category: 'Hand Block Print' } as any);
    // The canonical slug (not the raw typed term) is persisted.
    expect(rfqModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'hand-block-print' }),
    );
    expect(tagService.recordUsage).toHaveBeenCalledWith(['hand-block-print'], BUYER);
  });

  it('listBoard queries open RFQs, narrowing by category', async () => {
    const rfqModel = makeRfqModel();
    const svc = makeSvc(rfqModel, makeQuoteModel());
    await svc.listBoard(SELLER, { category: 'weaving' });
    expect(rfqModel.find).toHaveBeenCalledWith({ status: 'open', category: 'weaving' });
  });

  it('listBoard with matchedToMyWork narrows to the viewer supply categories', async () => {
    const rfqModel = makeRfqModel();
    const listingModel = {
      distinct: vi.fn(() => ({ exec: async () => ['weaving', 'dyeing'] })),
    } as any;
    const svc = makeSvc(rfqModel, makeQuoteModel(), listingModel);
    await svc.listBoard(SELLER, { matchedToMyWork: true } as any);
    expect(rfqModel.find).toHaveBeenCalledWith({
      status: 'open',
      category: { $in: ['weaving', 'dyeing'] },
    });
  });

  it('listBoard with notQuotedByMe excludes the viewer-quoted RFQ ids', async () => {
    const rfqModel = makeRfqModel();
    const quoteModel = makeQuoteModel();
    quoteModel.distinct = vi.fn(() => ({ exec: async () => ['rfq-9'] }));
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.listBoard(SELLER, { notQuotedByMe: true } as any);
    expect(rfqModel.find).toHaveBeenCalledWith({
      status: 'open',
      _id: { $nin: ['rfq-9'] },
    });
  });

  it('createQuote (new) inserts + increments quotesCount', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing: null });
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.createQuote(SELLER, 'rfq-1', { price: 100 });
    expect(quoteModel.create).toHaveBeenCalled();
    expect(rfqModel.updateOne).toHaveBeenCalledWith({ _id: 'rfq-1' }, { $inc: { quotesCount: 1 } });
  });

  it('createQuote (existing) updates without incrementing the count', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const existing = { _id: 'q-1', save: vi.fn(async () => ({ _id: 'q-1' })) };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing });
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.createQuote(SELLER, 'rfq-1', { price: 120 });
    expect(existing.save).toHaveBeenCalled();
    expect(quoteModel.create).not.toHaveBeenCalled();
    // No $inc on an update; the only rfq write is the lowestQuotePrice recompute.
    expect(rfqModel.updateOne).not.toHaveBeenCalledWith(
      { _id: 'rfq-1' },
      { $inc: { quotesCount: 1 } },
    );
  });

  it('createQuote recomputes the denormalized lowest live quote price', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing: null });
    quoteModel.aggregate = vi.fn(async () => [{ low: 19500 }]);
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.createQuote(SELLER, 'rfq-1', { price: 19500 });
    expect(rfqModel.updateOne).toHaveBeenCalledWith(
      { _id: 'rfq-1' },
      { $set: { lowestQuotePrice: 19500 } },
    );
  });

  it('shortlistQuote marks a sent quote shortlisted (buyer, open RFQ only)', async () => {
    const quote = {
      _id: 'q-1',
      rfqId: 'rfq-1',
      status: 'sent',
      save: vi.fn(() => Promise.resolve()),
    };
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const svc = makeSvc(makeRfqModel({ findByIdDoc: rfq }), makeQuoteModel({ findByIdDoc: quote }));
    await svc.shortlistQuote(BUYER, 'q-1');
    expect(quote.status).toBe('shortlisted');
  });

  it('shortlistQuote rejects a non-live quote', async () => {
    const quote = { _id: 'q-1', rfqId: 'rfq-1', status: 'withdrawn', save: vi.fn() };
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const svc = makeSvc(makeRfqModel({ findByIdDoc: rfq }), makeQuoteModel({ findByIdDoc: quote }));
    await expect(svc.shortlistQuote(BUYER, 'q-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('declineQuote marks a live quote declined and recomputes the low price', async () => {
    const quote = {
      _id: 'q-1',
      rfqId: 'rfq-1',
      status: 'shortlisted',
      save: vi.fn(() => Promise.resolve()),
    };
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ findByIdDoc: quote });
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.declineQuote(BUYER, 'q-1');
    expect(quote.status).toBe('declined');
    expect(rfqModel.updateOne).toHaveBeenCalledWith(
      { _id: 'rfq-1' },
      { $set: { lowestQuotePrice: null } },
    );
  });

  it('createQuote rejects a closed RFQ', async () => {
    const rfqModel = makeRfqModel({
      findByIdDoc: { _id: 'rfq-1', buyerUserId: BUYER, status: 'closed' },
    });
    const svc = makeSvc(rfqModel, makeQuoteModel());
    await expect(svc.createQuote(SELLER, 'rfq-1', { price: 1 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createQuote rejects the buyer quoting their own request', async () => {
    const rfqModel = makeRfqModel({
      findByIdDoc: { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' },
    });
    const svc = makeSvc(rfqModel, makeQuoteModel());
    await expect(svc.createQuote(BUYER, 'rfq-1', { price: 1 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('acceptQuote marks the quote accepted and awards the RFQ', async () => {
    const quote = {
      _id: 'q-1',
      rfqId: 'rfq-1',
      save: vi.fn(() => Promise.resolve()),
      status: 'sent',
    };
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ findByIdDoc: quote });
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.acceptQuote(BUYER, 'q-1');
    expect(quote.status).toBe('accepted');
    expect(rfqModel.updateOne).toHaveBeenCalledWith(
      { _id: 'rfq-1' },
      { $set: { status: 'awarded' } },
    );
  });

  it('getRfq enriches the buyer track record + anonymized quote spread', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open', title: 'x' };
    const rfqModel = makeRfqModel();
    rfqModel.findById = vi.fn(() => chain(rfq));
    rfqModel.countDocuments = vi.fn(async (f: any) => (f.status === 'awarded' ? 9 : 14));
    const quoteModel = makeQuoteModel();
    quoteModel.aggregate = vi.fn(async () => [{ count: 6, low: 19500, high: 25600 }]);
    const svc = makeSvc(rfqModel, quoteModel);
    const res = await svc.getRfq('rfq-1');
    expect(res.buyerStats).toEqual({ rfqsPosted: 14, rfqsAwarded: 9 });
    expect(res.quoteStats).toEqual({ count: 6, low: 19500, high: 25600 });
  });

  it('createQuote persists the structured offer fields (rate breakdown, includes, validity, samples)', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open' };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing: null });
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.createQuote(SELLER, 'rfq-1', {
      price: 22400,
      rate: 56,
      rateQuantity: 400,
      includes: ['approval-sample', 'packing'],
      validityDays: 7,
      sampleUrls: ['https://r2/x.webp'],
    } as any);
    expect(quoteModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        price: 22400,
        rate: 56,
        rateQuantity: 400,
        includes: ['approval-sample', 'packing'],
        validityDays: 7,
        sampleUrls: ['https://r2/x.webp'],
      }),
    );
  });

  it('listQuotesForMyRfq 404s a non-owner', async () => {
    const rfqModel = makeRfqModel({ findByIdDoc: { _id: 'rfq-1', buyerUserId: SELLER } });
    const svc = makeSvc(rfqModel, makeQuoteModel());
    await expect(svc.listQuotesForMyRfq(BUYER, 'rfq-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('withdrawQuote 404s a non-owner seller', async () => {
    const quoteModel = makeQuoteModel({ findByIdDoc: { _id: 'q-1', sellerUserId: SELLER } });
    const svc = makeSvc(makeRfqModel(), quoteModel);
    await expect(svc.withdrawQuote(BUYER, 'q-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── Demo / sample content (isDemo) ─────────────────────────────────

  it('createRfq stamps isDemo=false for a real buyer', async () => {
    const rfqModel = makeRfqModel();
    const svc = makeSvc(rfqModel, makeQuoteModel());
    await svc.createRfq(BUYER, { title: 'Need cotton', category: 'weaving' } as any);
    expect(rfqModel.create).toHaveBeenCalledWith(expect.objectContaining({ isDemo: false }));
  });

  it('createRfq stamps isDemo=true for a seeded demo buyer', async () => {
    const rfqModel = makeRfqModel();
    const svc = makeSvc(
      rfqModel,
      makeQuoteModel(),
      makeListingModel(),
      makeTagService(),
      makeUserModel([BUYER]),
    );
    await svc.createRfq(BUYER, { title: 'Sample', category: 'weaving' } as any);
    expect(rfqModel.create).toHaveBeenCalledWith(expect.objectContaining({ isDemo: true }));
  });

  it('createQuote blocks a demo seller quoting a real RFQ', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open', isDemo: false };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const svc = makeSvc(
      rfqModel,
      makeQuoteModel({ existing: null }),
      makeListingModel(),
      makeTagService(),
      makeUserModel([SELLER]), // seller is demo, RFQ is real -> cross blocked
    );
    await expect(svc.createQuote(SELLER, 'rfq-1', { price: 100 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createQuote blocks a real seller quoting a demo RFQ', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open', isDemo: true };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const svc = makeSvc(rfqModel, makeQuoteModel({ existing: null })); // seller real, RFQ demo
    await expect(svc.createQuote(SELLER, 'rfq-1', { price: 100 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createQuote allows a demo seller on a demo RFQ but does NOT increment quotesCount', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open', isDemo: true };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing: null });
    const svc = makeSvc(
      rfqModel,
      quoteModel,
      makeListingModel(),
      makeTagService(),
      makeUserModel([SELLER]), // both demo -> allowed
    );
    await svc.createQuote(SELLER, 'rfq-1', { price: 100 } as any);
    expect(quoteModel.create).toHaveBeenCalledWith(expect.objectContaining({ isDemo: true }));
    // demo quote stays out of the visible count
    expect(rfqModel.updateOne).not.toHaveBeenCalledWith(
      { _id: 'rfq-1' },
      { $inc: { quotesCount: 1 } },
    );
  });

  it('recomputeLowestQuote excludes demo quotes from the real aggregate', async () => {
    const rfq = { _id: 'rfq-1', buyerUserId: BUYER, status: 'open', isDemo: false };
    const rfqModel = makeRfqModel({ findByIdDoc: rfq });
    const quoteModel = makeQuoteModel({ existing: null });
    quoteModel.aggregate = vi.fn(async () => []);
    const svc = makeSvc(rfqModel, quoteModel);
    await svc.createQuote(SELLER, 'rfq-1', { price: 100 } as any);
    // The $match for the low-price aggregate carries the demo exclusion.
    expect(quoteModel.aggregate).toHaveBeenCalledWith([
      {
        $match: expect.objectContaining({ isDemo: { $ne: true } }),
      },
      { $group: { _id: null, low: { $min: '$price' } } },
    ]);
  });
});
