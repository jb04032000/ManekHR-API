/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive
// schema imports (Inquiry / Listing / User) skip vitest's
// reflect-metadata pipeline.
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

// Sentry-nestjs swallows errors with no transport; stub it so the duplicate-key
// catch branch can run without spinning up the SDK.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { InquiryService } from '../inquiry.service';

/**
 * Unit coverage for `InquiryService` (M1.5). Exercises the four business
 * rules: self-inquiry block, public-listing gate, dedupe via the unique
 * compound index (incl. the E11000 race), and the seller-side lead cap.
 * Models, AllowanceService, and the audit + PostHog seams are mocked.
 */

const SELLER = new Types.ObjectId();
const BUYER = new Types.ObjectId();
const LISTING = new Types.ObjectId();

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    skip: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

const publicListing = {
  _id: LISTING,
  ownerUserId: SELLER,
  status: 'active',
  moderationStatus: 'approved',
};

function build() {
  const inquiryModel: any = {
    findOne: vi.fn(() => chain(null)),
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    find: vi.fn(() => chain([])),
  };
  const listingModel: any = {
    findOne: vi.fn(() => chain(publicListing)),
    find: vi.fn(() => chain([])),
  };
  const userModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain({ name: 'Anand Patel' })),
  };
  const allowances: any = { canUseLead: vi.fn().mockResolvedValue(true) };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const posthog: any = { capture: vi.fn() };
  const notifications: any = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const inbox: any = {
    findOrCreateContextThread: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getThreadIdsForContext: vi.fn().mockResolvedValue(new Map()),
  };
  const service = new InquiryService(
    inquiryModel,
    listingModel,
    userModel,
    allowances,
    audit,
    posthog,
    notifications,
    inbox,
  );
  return {
    service,
    inquiryModel,
    listingModel,
    userModel,
    allowances,
    audit,
    posthog,
    notifications,
    inbox,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('InquiryService.create', () => {
  it('seeds the inbox thread + the buyer message so the inquiry lands in the Inbox', async () => {
    const f = build();
    const inquiryId = new Types.ObjectId();
    f.inquiryModel.create.mockResolvedValue({ _id: inquiryId, message: 'Need 500m zari border' });

    await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {
      message: 'Need 500m zari border',
    });

    expect(f.inbox.findOrCreateContextThread).toHaveBeenCalledWith(
      BUYER.toHexString(),
      SELLER.toHexString(),
      'Inquiry',
      inquiryId.toHexString(),
    );
    expect(f.inbox.sendMessage).toHaveBeenCalledWith(
      BUYER.toHexString(),
      expect.any(String),
      expect.objectContaining({ body: 'Need 500m zari border' }),
    );
  });

  it('seeds the thread but sends no message when the inquiry has no text', async () => {
    const f = build();
    f.inquiryModel.create.mockResolvedValue({ _id: new Types.ObjectId(), message: '' });

    await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {});

    expect(f.inbox.findOrCreateContextThread).toHaveBeenCalled();
    expect(f.inbox.sendMessage).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the listing id is not a valid ObjectId', async () => {
    const f = build();
    await expect(f.service.create(BUYER.toHexString(), 'not-an-objectid', {})).rejects.toThrow(
      NotFoundException,
    );
    expect(f.listingModel.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a non-public listing (draft / pending / rejected / paused)', async () => {
    const f = build();
    f.listingModel.findOne = vi.fn(() => chain(null));
    await expect(f.service.create(BUYER.toHexString(), LISTING.toHexString(), {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('blocks a seller from sending an inquiry to their own listing', async () => {
    const f = build();
    // The "buyer" is the same as the listing owner.
    await expect(
      f.service.create(SELLER.toHexString(), LISTING.toHexString(), {}),
    ).rejects.toMatchObject({
      response: { code: 'CONNECT_SELF_INQUIRY_NOT_ALLOWED' },
    });
  });

  it('returns the existing inquiry when the buyer has already inquired (idempotent dedupe)', async () => {
    const f = build();
    const existing = { _id: new Types.ObjectId(), message: 'old' };
    f.inquiryModel.findOne = vi.fn(() => chain(existing));

    const result = await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {
      message: 'new',
    });

    expect(result).toBe(existing);
    expect(f.inquiryModel.create).not.toHaveBeenCalled();
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });

  it('throws SELLER_LEAD_CAP_REACHED when the seller is at their inquiry limit', async () => {
    const f = build();
    f.allowances.canUseLead = vi.fn().mockResolvedValue(false);

    await expect(
      f.service.create(BUYER.toHexString(), LISTING.toHexString(), {}),
    ).rejects.toMatchObject({
      response: { code: 'CONNECT_SELLER_LEAD_CAP_REACHED' },
    });
    expect(f.inquiryModel.create).not.toHaveBeenCalled();
  });

  it('creates the inquiry + audits + emits PostHog on the happy path', async () => {
    const f = build();
    const created = {
      _id: new Types.ObjectId(),
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      listingId: LISTING,
      message: 'Interested',
      status: 'sent',
    };
    f.inquiryModel.create = vi.fn().mockResolvedValue(created);

    const result = await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {
      message: 'Interested',
    });

    expect(result).toBe(created);
    expect(f.inquiryModel.create).toHaveBeenCalledTimes(1);
    const createArg = f.inquiryModel.create.mock.calls[0][0];
    expect(createArg.message).toBe('Interested');
    expect(createArg.status).toBe('sent');
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Inquiry',
        action: 'inquiry_created',
        actorId: BUYER.toHexString(),
      }),
    );
    expect(f.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'connect.inquiry_created',
        distinctId: BUYER.toHexString(),
      }),
    );
  });

  it('notifies the seller (connect.inquiry_received) on the happy path', async () => {
    const f = build();
    const created = {
      _id: new Types.ObjectId(),
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      listingId: LISTING,
      message: 'Interested',
      status: 'sent',
    };
    f.inquiryModel.create = vi.fn().mockResolvedValue(created);
    f.listingModel.findOne = vi.fn(() => chain({ ...publicListing, title: 'Gold zari rolls' }));

    await f.service.create(BUYER.toHexString(), LISTING.toHexString(), { message: 'Interested' });

    expect(f.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'connect.inquiry_received',
        recipientId: SELLER,
        actorId: BUYER,
        entityType: 'Inquiry',
        entityId: String(created._id),
      }),
    );
    // The buyer's name + listing title land in the human message.
    const arg = f.notifications.dispatch.mock.calls[0][0];
    expect(arg.message).toContain('Anand Patel');
    expect(arg.message).toContain('Gold zari rolls');
  });

  it('still creates the inquiry when the notification dispatch rejects', async () => {
    const f = build();
    f.inquiryModel.create = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      listingId: LISTING,
      status: 'sent',
    });
    f.notifications.dispatch = vi.fn().mockRejectedValue(new Error('bell down'));

    await expect(
      f.service.create(BUYER.toHexString(), LISTING.toHexString(), {}),
    ).resolves.toBeTruthy();
  });

  it('recovers from the E11000 race and returns the existing inquiry that won', async () => {
    const f = build();
    // First findOne (dedupe check) returns null (no existing row yet);
    // create throws E11000 (concurrent insert won the unique index);
    // second findOne (post-catch) returns the winner.
    const winner = { _id: new Types.ObjectId(), message: 'first' };
    let findOneCall = 0;
    f.inquiryModel.findOne = vi.fn(() => {
      findOneCall += 1;
      return chain(findOneCall === 1 ? null : winner);
    });
    const dupErr: any = new Error('E11000 duplicate key error');
    dupErr.code = 11000;
    f.inquiryModel.create = vi.fn().mockRejectedValue(dupErr);

    const result = await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {
      message: 'second',
    });

    expect(result).toBe(winner);
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });

  it('rethrows a non-duplicate create error after capturing it for Sentry', async () => {
    const f = build();
    f.inquiryModel.create = vi.fn().mockRejectedValue(new Error('mongo down'));

    await expect(f.service.create(BUYER.toHexString(), LISTING.toHexString(), {})).rejects.toThrow(
      'mongo down',
    );
  });

  it('passes the seller cycle count (gte month start) to canUseLead', async () => {
    const f = build();
    f.inquiryModel.countDocuments = vi.fn().mockResolvedValue(7);
    f.inquiryModel.create = vi.fn().mockResolvedValue({ _id: new Types.ObjectId() });

    await f.service.create(BUYER.toHexString(), LISTING.toHexString(), {});

    expect(f.allowances.canUseLead).toHaveBeenCalledWith(SELLER.toHexString(), 7);
    const countArg = f.inquiryModel.countDocuments.mock.calls[0][0];
    // The cycle filter is `{ sellerUserId, createdAt: { $gte: <month-start> } }`.
    expect(countArg.sellerUserId).toEqual(SELLER);
    expect(countArg.createdAt.$gte).toBeInstanceOf(Date);
  });
});

describe('InquiryService.listMineSent + listMineReceived', () => {
  it('hydrates the buyer outbox with the listing + the SELLER party, newest first', async () => {
    const f = build();
    const inq = {
      _id: new Types.ObjectId(),
      listingId: LISTING,
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      message: 'hi',
      status: 'sent',
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    };
    f.inquiryModel.find = vi.fn(() => chain([inq]));
    f.listingModel.find = vi.fn(() =>
      chain([
        { _id: LISTING, title: 'Zari work', images: ['https://img/1.jpg'], status: 'active' },
      ]),
    );
    f.userModel.find = vi.fn(() =>
      chain([{ _id: SELLER, name: 'Meera', profilePicture: 'https://img/a.jpg', handle: 'meera' }]),
    );

    const { items } = await f.service.listMineSent(BUYER.toHexString());
    const [row] = items;

    expect(f.inquiryModel.find.mock.calls[0][0].buyerUserId).toEqual(BUYER);
    // Batch lookups: one listing query + one user query (no N+1).
    expect(f.listingModel.find).toHaveBeenCalledTimes(1);
    expect(f.userModel.find).toHaveBeenCalledTimes(1);
    expect(row.listing).toMatchObject({
      listingId: LISTING.toHexString(),
      title: 'Zari work',
      coverImage: 'https://img/1.jpg',
      status: 'active',
    });
    // The other party in the buyer's outbox is the seller.
    expect(row.party).toMatchObject({
      userId: SELLER.toHexString(),
      name: 'Meera',
      avatar: 'https://img/a.jpg',
      handle: 'meera',
    });
    expect(row.message).toBe('hi');
    expect(row.status).toBe('sent');
  });

  it('hydrates the seller inbox with the BUYER party; missing avatar / cover are null', async () => {
    const f = build();
    const inq = {
      _id: new Types.ObjectId(),
      listingId: LISTING,
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      message: 'interested',
      status: 'sent',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    f.inquiryModel.find = vi.fn(() => chain([inq]));
    f.listingModel.find = vi.fn(() =>
      chain([{ _id: LISTING, title: 'Zari work', images: [], status: 'paused' }]),
    );
    f.userModel.find = vi.fn(() =>
      chain([{ _id: BUYER, name: 'Ramesh', profilePicture: undefined, handle: null }]),
    );

    const { items } = await f.service.listMineReceived(SELLER.toHexString());
    const [row] = items;

    expect(f.inquiryModel.find.mock.calls[0][0].sellerUserId).toEqual(SELLER);
    expect(row.party).toMatchObject({ userId: BUYER.toHexString(), name: 'Ramesh' });
    expect(row.party.avatar).toBeNull();
    expect(row.party.handle).toBeNull();
    expect(row.listing).toMatchObject({ title: 'Zari work', coverImage: null, status: 'paused' });
  });

  it('returns null listing / party when the referenced docs are gone', async () => {
    const f = build();
    const inq = {
      _id: new Types.ObjectId(),
      listingId: LISTING,
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      message: '',
      status: 'sent',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    f.inquiryModel.find = vi.fn(() => chain([inq]));
    f.listingModel.find = vi.fn(() => chain([]));
    f.userModel.find = vi.fn(() => chain([]));

    const { items } = await f.service.listMineSent(BUYER.toHexString());
    const [row] = items;

    expect(row.listing).toBeNull();
    expect(row.party).toBeNull();
  });

  it('clamps an over-large limit to the 50 max (over-fetch is limit+1)', async () => {
    const f = build();
    const c = chain([]);
    f.inquiryModel.find = vi.fn(() => c);
    await f.service.listMineReceived(SELLER.toHexString(), { limit: 500 });
    expect(c.limit).toHaveBeenCalledWith(51);
  });

  it('applies the keyset cursor as a strictly-older filter and emits a nextCursor when the window is full', async () => {
    const f = build();
    // 21 rows for the default page of 20 -> there IS a next page.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      _id: new Types.ObjectId(),
      listingId: LISTING,
      buyerUserId: BUYER,
      sellerUserId: SELLER,
      message: `m${i}`,
      status: 'sent',
      createdAt: new Date(2026, 0, 21 - i),
      updatedAt: new Date(2026, 0, 21 - i),
    }));
    f.inquiryModel.find = vi.fn(() => chain(rows));
    f.listingModel.find = vi.fn(() => chain([]));
    f.userModel.find = vi.fn(() => chain([]));

    const cursorRow = { _id: new Types.ObjectId(), createdAt: new Date('2026-06-11') };
    const { encodeCursor } = await import('../../../common/keyset-cursor');
    const page = await f.service.listMineReceived(SELLER.toHexString(), {
      cursor: encodeCursor(cursorRow),
    });

    // The scope filter carries the keyset $or clause.
    expect(f.inquiryModel.find.mock.calls[0][0].$or).toBeDefined();
    // Page caps at 20 and surfaces a cursor for the next page.
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(encodeCursor(rows[19]));
  });
});

describe('InquiryService.onInboxThreadActivity (status sync)', () => {
  function inquiryDoc(status: string) {
    return {
      sellerUserId: SELLER,
      buyerUserId: BUYER,
      status,
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('moves sent -> viewed when the SELLER opens the thread', async () => {
    const f = build();
    const doc = inquiryDoc('sent');
    f.inquiryModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'Inquiry',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(SELLER),
      kind: 'read',
    });
    expect(doc.status).toBe('viewed');
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('moves to replied when the SELLER sends a message', async () => {
    const f = build();
    const doc = inquiryDoc('viewed');
    f.inquiryModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'Inquiry',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(SELLER),
      kind: 'reply',
    });
    expect(doc.status).toBe('replied');
  });

  it('ignores the BUYER opening their own thread', async () => {
    const f = build();
    const doc = inquiryDoc('sent');
    f.inquiryModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'Inquiry',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(BUYER),
      kind: 'read',
    });
    expect(doc.status).toBe('sent');
    expect(doc.save).not.toHaveBeenCalled();
  });
});
