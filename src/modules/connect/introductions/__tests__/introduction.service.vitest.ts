/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema imports don't trip vitest's reflect-metadata pipeline
// (see auth.service.audit.vitest.ts / review.service.vitest.ts for the pattern).
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
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IntroductionService } from '../introduction.service';

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

describe('IntroductionService (broker introductions)', () => {
  let introductionModel: any;
  let profileModel: any;
  let userModel: any;
  let notifications: any;
  let posthog: any;

  // Two parties whose ObjectId hex strings have a known low/high ordering so we
  // can assert canonical ordering + roleOfLow derivation deterministically.
  const broker = new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
  const low = new Types.ObjectId('111111111111111111111111');
  const high = new Types.ObjectId('999999999999999999999999');

  function build() {
    return new IntroductionService(
      introductionModel,
      profileModel,
      userModel,
      notifications,
      posthog,
    );
  }

  /** Default: broker IS a broker; both parties live + distinct phones; no dupe. */
  function happyPath() {
    profileModel.findOne = vi.fn(() => chain({ isBroker: true }));
    userModel.find = vi.fn(() =>
      chain([
        { _id: low, mobile: '9876500001' },
        { _id: high, mobile: '9876500002' },
      ]),
    );
    introductionModel.findOne = vi.fn(() => chain(null)); // no existing dedup row
  }

  beforeEach(() => {
    introductionModel = {
      findOne: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
      create: vi.fn((doc: any) => Promise.resolve({ _id: new Types.ObjectId(), ...doc })),
    };
    profileModel = { findOne: vi.fn(() => chain({ isBroker: true })) };
    userModel = { find: vi.fn(() => chain([])) };
    notifications = { dispatch: vi.fn().mockResolvedValue(undefined) };
    posthog = { capture: vi.fn() };
  });

  // ── create ────────────────────────────────────────────────────────────────

  it('rejects a non-broker creator', async () => {
    profileModel.findOne = vi.fn(() => chain({ isBroker: false }));
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(introductionModel.create).not.toHaveBeenCalled();
  });

  it('rejects a missing broker profile as a non-broker', async () => {
    profileModel.findOne = vi.fn(() => chain(null));
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'seller',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects introducing a person to themselves (same party)', async () => {
    happyPath();
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(low),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(introductionModel.create).not.toHaveBeenCalled();
  });

  it('rejects the broker introducing themselves (broker is a party)', async () => {
    happyPath();
    await expect(
      build().create(broker, {
        partyAUserId: String(broker),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when a party is not a live/verified member', async () => {
    happyPath();
    // Only ONE of the two ids comes back from the live+verified guard query.
    userModel.find = vi.fn(() => chain([{ _id: low, mobile: '9876500001' }]));
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(introductionModel.create).not.toHaveBeenCalled();
  });

  it('rejects two parties sharing the same phone (same-person gaming)', async () => {
    happyPath();
    userModel.find = vi.fn(() =>
      chain([
        { _id: low, mobile: '+91 98765 00001' },
        { _id: high, mobile: '9876500001' }, // same last-10 as the other
      ]),
    );
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(introductionModel.create).not.toHaveBeenCalled();
  });

  it('conflicts when a non-deleted introduction already exists for the pair', async () => {
    happyPath();
    introductionModel.findOne = vi.fn(() => chain({ _id: new Types.ObjectId() }));
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(introductionModel.create).not.toHaveBeenCalled();
  });

  it('translates an E11000 duplicate-key race into a friendly conflict', async () => {
    happyPath();
    introductionModel.create = vi.fn().mockRejectedValue({ code: 11000 });
    await expect(
      build().create(broker, {
        partyAUserId: String(low),
        partyBUserId: String(high),
        roleOfA: 'buyer',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('stores the canonical pair and roleOfLow=roleOfA when partyA is the low id', async () => {
    happyPath();
    await build().create(broker, {
      partyAUserId: String(low), // partyA = low
      partyBUserId: String(high),
      roleOfA: 'seller',
    });
    const arg = introductionModel.create.mock.calls[0][0];
    expect(String(arg.userLow)).toBe(String(low));
    expect(String(arg.userHigh)).toBe(String(high));
    expect(arg.roleOfLow).toBe('seller'); // partyA is low -> roleOfLow = roleOfA
    expect(arg.status).toBe('pending');
  });

  it('derives roleOfLow as the OPPOSITE when partyA is the high id', async () => {
    happyPath();
    await build().create(broker, {
      partyAUserId: String(high), // partyA = high
      partyBUserId: String(low),
      roleOfA: 'buyer',
    });
    const arg = introductionModel.create.mock.calls[0][0];
    expect(String(arg.userLow)).toBe(String(low));
    expect(String(arg.userHigh)).toBe(String(high));
    // partyA (buyer) is the HIGH party, so the LOW party's role is the opposite.
    expect(arg.roleOfLow).toBe('seller');
  });

  it('notifies BOTH parties and emits posthog on create', async () => {
    happyPath();
    await build().create(broker, {
      partyAUserId: String(low),
      partyBUserId: String(high),
      roleOfA: 'buyer',
    });
    // best-effort notify is fire-and-forget (void) — let microtasks flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications.dispatch).toHaveBeenCalledTimes(2);
    const recipients = notifications.dispatch.mock.calls.map((c: any[]) =>
      String(c[0].recipientId),
    );
    expect(recipients).toEqual(expect.arrayContaining([String(low), String(high)]));
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.introduction_created' }),
    );
  });

  // ── confirm ─────────────────────────────────────────────────────────────────

  /** A live introduction doc with a working `save()` + the given confirm state. */
  function liveDoc(over: Partial<any> = {}) {
    const doc: any = {
      _id: new Types.ObjectId(),
      brokerUserId: broker,
      userLow: low,
      userHigh: high,
      roleOfLow: 'buyer',
      status: 'pending',
      confirmedByLowAt: null,
      confirmedByHighAt: null,
      deletedAt: null,
      ...over,
    };
    doc.save = vi.fn().mockResolvedValue(doc);
    return doc;
  }

  it('confirm: a non-party (incl. the broker) cannot confirm', async () => {
    const doc = liveDoc();
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(build().confirm(String(doc._id), broker)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('confirm: a party sets ONLY their own side and does not flip status alone', async () => {
    const doc = liveDoc();
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().confirm(String(doc._id), low);
    expect(doc.confirmedByLowAt).toBeInstanceOf(Date);
    expect(doc.confirmedByHighAt).toBeNull(); // never touches the other side
    expect(doc.status).toBe('pending'); // one side only -> still pending
    expect(doc.save).toHaveBeenCalled();
  });

  it('confirm: status flips to confirmed only when BOTH sides have confirmed', async () => {
    // Low already confirmed; now the HIGH party confirms -> both sides set.
    const doc = liveDoc({ confirmedByLowAt: new Date() });
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().confirm(String(doc._id), high);
    expect(doc.confirmedByHighAt).toBeInstanceOf(Date);
    expect(doc.status).toBe('confirmed');
    await Promise.resolve();
    await Promise.resolve();
    // On full confirmation: notify the broker + the other party.
    const recipients = notifications.dispatch.mock.calls.map((c: any[]) =>
      String(c[0].recipientId),
    );
    expect(recipients).toEqual(expect.arrayContaining([String(broker), String(low)]));
  });

  it('confirm: is idempotent when the actor already confirmed their side', async () => {
    const alreadyAt = new Date('2020-01-01');
    const doc = liveDoc({ confirmedByLowAt: alreadyAt });
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().confirm(String(doc._id), low);
    expect(doc.confirmedByLowAt).toBe(alreadyAt); // not overwritten
    expect(doc.status).toBe('pending');
  });

  it('confirm: 404 for a missing / soft-deleted introduction', async () => {
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await expect(build().confirm(String(new Types.ObjectId()), low)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── decline ─────────────────────────────────────────────────────────────────

  it('decline: a party soft-deletes (status=declined + deletedAt set)', async () => {
    const doc = liveDoc();
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await build().decline(String(doc._id), high);
    expect(doc.status).toBe('declined');
    expect(doc.deletedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });

  it('decline: the broker (non-party) cannot decline', async () => {
    const doc = liveDoc();
    introductionModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(build().decline(String(doc._id), broker)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  // ── reads ───────────────────────────────────────────────────────────────────

  it('listPendingForUser: filters to pending, not-deleted, own side unconfirmed', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listPendingForUser(low);
    const filter = introductionModel.find.mock.calls[0][0];
    expect(filter.status).toBe('pending');
    expect(filter.deletedAt).toEqual({ $in: [null, undefined] });
    // Either-side clause requires the caller's OWN side to be unconfirmed.
    expect(filter.$or).toEqual([
      { userLow: expect.anything(), confirmedByLowAt: { $in: [null, undefined] } },
      { userHigh: expect.anything(), confirmedByHighAt: { $in: [null, undefined] } },
    ]);
  });

  it('listForBroker: scopes to the broker, excludes deleted, applies status filter', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listForBroker(broker, 'confirmed');
    const filter = introductionModel.find.mock.calls[0][0];
    expect(String(filter.brokerUserId)).toBe(String(broker));
    expect(filter.deletedAt).toEqual({ $in: [null, undefined] });
    expect(filter.status).toBe('confirmed');
  });

  it('listForBroker: omits the status filter when none is given', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listForBroker(broker);
    const filter = introductionModel.find.mock.calls[0][0];
    expect(filter.status).toBeUndefined();
  });

  // ── listReceivedForUser ───────────────────────────────────────────────────────

  it('listReceivedForUser: scopes to confirmed rows where I am a party, excludes deleted', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listReceivedForUser(low);
    const filter = introductionModel.find.mock.calls[0][0];
    // Default status is confirmed (review the broker of a confirmed intro).
    expect(filter.status).toBe('confirmed');
    expect(filter.deletedAt).toEqual({ $in: [null, undefined] });
    // Either-side party clause — NO confirmedBy* sub-clause (unlike pending) and
    // NO brokerUserId clause (broker-only rows must be excluded).
    expect(filter.$or).toEqual([{ userLow: expect.anything() }, { userHigh: expect.anything() }]);
    expect(filter.brokerUserId).toBeUndefined();
  });

  it('listReceivedForUser: respects an explicit status filter', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listReceivedForUser(low, 'declined');
    const filter = introductionModel.find.mock.calls[0][0];
    expect(filter.status).toBe('declined');
  });

  it('listReceivedForUser: the party clause uses my id (excludes broker-only rows)', async () => {
    introductionModel.find = vi.fn(() => chain([]));
    await build().listReceivedForUser(low);
    const filter = introductionModel.find.mock.calls[0][0];
    // Both sides of the $or must match MY id — a row where I am only the broker
    // (brokerUserId === me, userLow/userHigh !== me) can never satisfy this.
    expect(String(filter.$or[0].userLow)).toBe(String(low));
    expect(String(filter.$or[1].userHigh)).toBe(String(low));
  });

  it('listReceivedForUser: enriches each row with myRole + brokerId (I am the low party)', async () => {
    introductionModel.find = vi.fn(() =>
      chain([
        {
          _id: new Types.ObjectId(),
          brokerUserId: broker, // raw ObjectId ref
          userLow: low,
          userHigh: high,
          roleOfLow: 'buyer',
          status: 'confirmed',
        },
      ]),
    );
    const rows = await build().listReceivedForUser(low);
    expect(rows).toHaveLength(1);
    // I am the LOW party, so my role is roleOfLow as-is.
    expect(rows[0].myRole).toBe('buyer');
    expect(rows[0].brokerId).toBe(String(broker));
  });

  it('listReceivedForUser: myRole is the OPPOSITE when I am the high party', async () => {
    introductionModel.find = vi.fn(() =>
      chain([
        {
          _id: new Types.ObjectId(),
          // brokerUserId returned as a POPULATED doc — brokerId resolves off _id.
          brokerUserId: { _id: broker, name: 'Broker B' },
          userLow: low,
          userHigh: high,
          roleOfLow: 'buyer',
          status: 'confirmed',
        },
      ]),
    );
    const rows = await build().listReceivedForUser(high);
    // I am the HIGH party, so my role is the opposite of roleOfLow (buyer).
    expect(rows[0].myRole).toBe('seller');
    expect(rows[0].brokerId).toBe(String(broker));
  });
});
