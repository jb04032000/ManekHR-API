/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { NotFoundException } from '@nestjs/common';
import { ListingModerationService } from '../listing-moderation.service';
import { AppModule } from '../../../../../common/enums/modules.enum';

function makeDoc<T extends Record<string, unknown>>(fields: T) {
  return { ...fields, save: vi.fn().mockResolvedValue(undefined) };
}

function queryChain(result: any) {
  const obj: any = {
    sort: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn(() => Promise.resolve(result)),
  };
  return obj;
}

const ADMIN = new Types.ObjectId().toHexString();

function build() {
  const model = { findById: vi.fn(), find: vi.fn() };
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const posthog = { capture: vi.fn() };
  const service = new ListingModerationService(
    model as any,
    audit as any,
    eventEmitter as any,
    posthog as any,
  );
  return { service, model, audit, eventEmitter, posthog };
}

describe('ListingModerationService.approve()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets moderationStatus approved + status active and saves', async () => {
    const f = build();
    const doc = makeDoc({ _id: 'id', moderationStatus: 'pending', status: 'pending_review' });
    f.model.findById.mockResolvedValue(doc);

    await f.service.approve('id', ADMIN);

    expect(doc.moderationStatus).toBe('approved');
    expect(doc.status).toBe('active');
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('audits listing_approved under AppModule.CONNECT with the optional note + emits PostHog', async () => {
    const f = build();
    const id = new Types.ObjectId();
    f.model.findById.mockResolvedValue(
      makeDoc({ _id: id, moderationStatus: 'pending', status: 'pending_review' }),
    );

    await f.service.approve(id.toHexString(), ADMIN, 'looks legit');

    const call = f.audit.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.CONNECT);
    expect(call.action).toBe('listing_approved');
    expect(call.actorId).toBe(ADMIN);
    expect(call.meta?.note).toBe('looks legit');
    expect(f.posthog.capture.mock.calls[0][0].event).toBe('connect.listing_approved');
  });

  it('throws NotFoundException when the listing does not exist', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(null);
    await expect(f.service.approve('id', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ListingModerationService.reject()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets moderationStatus rejected + status rejected + rejectionReason and saves', async () => {
    const f = build();
    const doc = makeDoc({ _id: 'id', moderationStatus: 'pending', status: 'pending_review' });
    f.model.findById.mockResolvedValue(doc);

    await f.service.reject('id', ADMIN, 'counterfeit goods');

    expect(doc.moderationStatus).toBe('rejected');
    expect(doc.status).toBe('rejected');
    expect((doc as any).rejectionReason).toBe('counterfeit goods');
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('audits listing_rejected with the reason', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(
      makeDoc({ _id: 'id', moderationStatus: 'pending', status: 'pending_review' }),
    );

    await f.service.reject('id', ADMIN, 'spam');

    const call = f.audit.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.CONNECT);
    expect(call.action).toBe('listing_rejected');
    expect(call.actorId).toBe(ADMIN);
    expect(call.reason).toBe('spam');
  });

  it('throws NotFoundException when the listing does not exist', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(null);
    await expect(f.service.reject('id', ADMIN, 'r')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ListingModerationService.listPending()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries pending listings, newest first', async () => {
    const f = build();
    const rows = [{ _id: '1' }, { _id: '2' }];
    f.model.find.mockReturnValue(queryChain(rows));

    const result = await f.service.listPending();

    expect(f.model.find.mock.calls[0][0].moderationStatus).toBe('pending');
    expect(result).toEqual(rows);
  });
});
