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
import { MentionSuggestService } from '../mention-suggest.service';

const oid = () => new Types.ObjectId();

// find().select().limit().lean().exec() -> resolves `val` (used by the
// users/pages/storefronts queries which cap with .limit()).
const findLimited = (val: any) => ({
  select: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(val) }) }) }),
});
// find().select().lean().exec() -> resolves `val` (used by the public-profile
// gate query + the block-rows query, neither of which calls .limit()).
const findUnlimited = (val: any) => ({
  select: () => ({ lean: () => ({ exec: () => Promise.resolve(val) }) }),
});

describe('MentionSuggestService.suggest', () => {
  const viewer = oid();
  let userModel: any;
  let profileModel: any;
  let pageModel: any;
  let storefrontModel: any;
  let blockModel: any;
  let svc: MentionSuggestService;

  beforeEach(() => {
    userModel = { find: vi.fn(() => findLimited([])) };
    profileModel = { find: vi.fn(() => findUnlimited([])) };
    pageModel = { find: vi.fn(() => findLimited([])) };
    storefrontModel = { find: vi.fn(() => findLimited([])) };
    blockModel = { find: vi.fn(() => findUnlimited([])) };
    svc = new MentionSuggestService(
      userModel,
      profileModel,
      pageModel,
      storefrontModel,
      blockModel,
    );
  });

  it('returns a compact public-profile suggestion and excludes viewer, blocked, and non-public', async () => {
    const publicUser = {
      _id: oid(),
      name: 'Nita Patel',
      handle: 'nita',
      profilePicture: 'pic.jpg',
    };
    const blockedUser = { _id: oid(), name: 'Nina Shah', handle: 'nina' };
    const privateUser = { _id: oid(), name: 'Nilesh Rao', handle: 'nilesh' };
    const selfUser = { _id: viewer, name: 'Nikhil Me', handle: 'me' };

    userModel.find = vi.fn(() => findLimited([publicUser, blockedUser, privateUser, selfUser]));
    // Only publicUser + blockedUser have a public profile; privateUser is hidden
    // (absent from this list) and must be dropped even though its name matched.
    profileModel.find = vi.fn(() =>
      findUnlimited([{ userId: publicUser._id }, { userId: blockedUser._id }, { userId: viewer }]),
    );
    // blockedUser blocked the viewer (bidirectional gate via either direction).
    blockModel.find = vi.fn(() =>
      findUnlimited([{ blockerUserId: blockedUser._id, blockedUserId: viewer }]),
    );

    const res = await svc.suggest(String(viewer), 'Ni', 'people');

    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({
      type: 'profile',
      id: String(publicUser._id),
      display: 'Nita Patel',
      href: '/connect/u/nita',
      avatar: 'pic.jpg',
    });
    // viewer self-mention, blocked user, and hidden profile are all excluded.
    const ids = res.map((r) => r.id);
    expect(ids).not.toContain(String(viewer));
    expect(ids).not.toContain(String(blockedUser._id));
    expect(ids).not.toContain(String(privateUser._id));
  });

  it("scope='companies' returns only company rows (no people or storefront queries)", async () => {
    const page = { _id: oid(), name: 'Acme Embroidery', slug: 'acme', logo: 'logo.png' };
    pageModel.find = vi.fn(() => findLimited([page]));

    const res = await svc.suggest(String(viewer), 'Ac', 'companies');

    expect(res).toEqual([
      {
        type: 'company',
        id: String(page._id),
        display: 'Acme Embroidery',
        href: '/connect/company/acme',
        avatar: 'logo.png',
      },
    ]);
    expect(userModel.find).not.toHaveBeenCalled();
    expect(storefrontModel.find).not.toHaveBeenCalled();
    // The company query pins the public-visibility gate (mirrors search helpers).
    expect(pageModel.find).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }));
  });

  it('returns [] for an empty/whitespace query without touching any model', async () => {
    const res = await svc.suggest(String(viewer), '   ', 'all');
    expect(res).toEqual([]);
    expect(blockModel.find).not.toHaveBeenCalled();
    expect(userModel.find).not.toHaveBeenCalled();
    expect(pageModel.find).not.toHaveBeenCalled();
    expect(storefrontModel.find).not.toHaveBeenCalled();
  });
});
