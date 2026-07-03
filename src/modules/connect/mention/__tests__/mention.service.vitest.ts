/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
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
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MentionService } from '../mention.service';

const oid = () => new Types.ObjectId();

describe('MentionService.resolveForWrite', () => {
  const author = oid();
  const personId = oid();
  let userModel: any;
  let profileModel: any;
  let pageModel: any;
  let storefrontModel: any;
  let blockModel: any;
  let network: any;
  let svc: MentionService;

  const leanOne = (val: any) => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(val) }) }),
  });
  const leanMany = (val: any) => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(val) }) }),
  });

  beforeEach(() => {
    userModel = {
      findById: vi.fn(() => leanOne({ _id: personId, name: 'Nita Patel', handle: 'nita' })),
    };
    profileModel = { findOne: vi.fn(() => leanOne({ userId: personId, visibility: 'public' })) };
    pageModel = { findById: vi.fn() };
    storefrontModel = { findById: vi.fn() };
    blockModel = { find: vi.fn(() => leanMany([])) };
    network = { listConnections: vi.fn().mockResolvedValue([]) };
    svc = new MentionService(
      userModel,
      profileModel,
      pageModel,
      storefrontModel,
      blockModel,
      network,
    );
  });

  it('resolves a public profile mention on a public post and returns it as a recipient', async () => {
    const res = await svc.resolveForWrite(
      author,
      'Great work @Nita Patel!',
      [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
      'public',
    );
    expect(res.stored).toHaveLength(1);
    expect(res.stored[0]).toMatchObject({
      type: 'profile',
      display: 'Nita Patel',
      href: '/connect/u/nita',
    });
    expect(res.recipientUserIds).toEqual([String(personId)]);
  });

  it('rejects when the @display token is not present in the body (order-match guard)', async () => {
    await expect(
      svc.resolveForWrite(
        author,
        'no token here',
        [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
        'public',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects over the cap', async () => {
    const many = Array.from({ length: 11 }, () => ({
      type: 'profile' as const,
      refId: String(oid()),
      display: 'X',
    }));
    await expect(
      svc.resolveForWrite(author, '@X'.repeat(11), many, 'public'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blocked target (bidirectional)', async () => {
    blockModel.find = vi.fn(() => leanMany([{ blockerUserId: personId, blockedUserId: author }]));
    await expect(
      svc.resolveForWrite(
        author,
        'hi @Nita Patel',
        [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
        'public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a hidden profile', async () => {
    profileModel.findOne = vi.fn(() => leanOne({ userId: personId, visibility: 'hidden' }));
    await expect(
      svc.resolveForWrite(
        author,
        'hi @Nita Patel',
        [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
        'public',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects tagging a non-connection into a connections-only post', async () => {
    await expect(
      svc.resolveForWrite(
        author,
        'hi @Nita Patel',
        [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
        'connections',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a connection into a connections-only post', async () => {
    network.listConnections = vi.fn().mockResolvedValue([{ userId: String(personId) }]);
    const res = await svc.resolveForWrite(
      author,
      'hi @Nita Patel',
      [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
      'connections',
    );
    expect(res.stored).toHaveLength(1);
  });

  it('does not notify a self-mention', async () => {
    userModel.findById = vi.fn(() => leanOne({ _id: author, name: 'Me', handle: 'me' }));
    profileModel.findOne = vi.fn(() => leanOne({ userId: author, visibility: 'public' }));
    const res = await svc.resolveForWrite(
      author,
      'note to @Me',
      [{ type: 'profile', refId: String(author), display: 'Me' }],
      'public',
    );
    expect(res.stored).toHaveLength(1);
    expect(res.recipientUserIds).toEqual([]);
  });

  it('resolves a company page mention and notifies the page owner', async () => {
    const pageId = oid();
    const ownerId = oid();
    pageModel.findById = vi.fn(() =>
      leanOne({ _id: pageId, slug: 'acme', ownerUserId: ownerId, name: 'Acme' }),
    );
    const res = await svc.resolveForWrite(
      author,
      'see @Acme',
      [{ type: 'company', refId: String(pageId), display: 'Acme' }],
      'public',
    );
    expect(res.stored[0]).toMatchObject({ type: 'company', href: '/connect/company/acme' });
    expect(res.recipientUserIds).toEqual([String(ownerId)]);
  });

  it('stores the CANONICAL entity name, rejecting a spoofed chip label (anti-spoof)', async () => {
    // The body shows "@Official Support" but the tagged user is really "Nita Patel".
    // The order-match runs against the canonical name, so the body must contain
    // "@Nita Patel" - it does not, so the spoofed tag is rejected.
    await expect(
      svc.resolveForWrite(
        author,
        'contact @Official Support now',
        [{ type: 'profile', refId: String(personId), display: 'Official Support' }],
        'public',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('judges connections-only reach against the AUDIENCE owner, not the actor (comment leak guard)', async () => {
    const postAuthor = oid();
    // The tagged person is a connection of the POST AUTHOR (audience), not of the
    // actor. listConnections returns members only for the audience owner.
    network.listConnections = vi.fn((id: { equals: (o: unknown) => boolean }) =>
      id.equals(postAuthor) ? Promise.resolve([{ userId: String(personId) }]) : Promise.resolve([]),
    );
    // With the audience owner passed -> allowed.
    const ok = await svc.resolveForWrite(
      author,
      'hi @Nita Patel',
      [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
      'connections',
      postAuthor,
    );
    expect(ok.stored).toHaveLength(1);
    // Without the audience owner (reach falls back to the actor, who is NOT
    // connected to the target) -> rejected. Proves the gate uses the audience.
    await expect(
      svc.resolveForWrite(
        author,
        'hi @Nita Patel',
        [{ type: 'profile', refId: String(personId), display: 'Nita Patel' }],
        'connections',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
