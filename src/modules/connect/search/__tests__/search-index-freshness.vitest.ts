/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from 'vitest';

/**
 * Index freshness verification suite (CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §6).
 *
 * Proves that every lifecycle event of an indexed entity is reflected in search:
 *  - CREATE → entity upserted (findable)
 *  - EDIT   → updated fields upserted (stale terms no longer match on next index call)
 *  - DELETE / UNPUBLISH / CLOSE → entity removed from the index (no ghost results)
 *  - BAN / ERASURE               → banned author's content dropped (no ghost)
 *
 * Covered verticals: People / Listings / Posts / Jobs (all four currently indexed).
 * Storefronts / Pages are not yet indexed (see the checklist §6 note on new
 * verticals), so they are not tested here.
 *
 * Strategy: unit-test `SearchService` directly with mocked Mongoose models and
 * a mocked `MeiliClient`. Every path exercises the event-handler entry point
 * (`handle*Changed`) so we confirm the full event→index pipeline.
 */

// Stub @nestjs/mongoose BEFORE importing SearchService.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types } from 'mongoose';
import { SearchService } from '../search.service';

// ── Mock chain helpers ────────────────────────────────────────────────────────

/** A Mongoose query chain stub whose final `.exec()` resolves `result`. */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    limit: vi.fn(() => c),
    sort: vi.fn(() => c),
    skip: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

// ── Service builder ───────────────────────────────────────────────────────────

function build(meiliEnabled = true) {
  const profileModel: any = {
    find: vi.fn(() => chain([])),
    findOne: vi.fn(() => chain(null)),
  };
  const userModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
  };
  const listingModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
    aggregate: vi.fn(() => chain([{ category: [], district: [] }])),
    countDocuments: vi.fn(() => chain(0)),
  };
  const postModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
  };
  const jobModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
  };
  // SRCH-VERT-1: storefront + company-page models for the two new verticals.
  const storefrontModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
  };
  const companyPageModel: any = {
    find: vi.fn(() => chain([])),
    findById: vi.fn(() => chain(null)),
  };
  const connectProfileService: any = { getPeopleByIds: vi.fn().mockResolvedValue([]) };
  const meili: any = {
    enabled: meiliEnabled,
    multiSearch: vi.fn().mockResolvedValue([{ hits: [] }]),
    upsertDocuments: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  };
  const erpLinkService: any = {
    getUserStatus: vi.fn().mockResolvedValue({ linked: false }),
  };
  const allowanceService: any = {
    getAllowances: vi.fn().mockResolvedValue({
      maxListings: 25,
      leadsPerMonth: -1,
      includedBoostCredits: 0,
      verifiedBadge: false,
      searchPriority: 0,
    }),
  };

  const service = new SearchService(
    profileModel,
    userModel,
    listingModel,
    postModel,
    jobModel,
    connectProfileService,
    meili,
    erpLinkService,
    allowanceService,
    undefined, // overLimit (optional)
    undefined, // searchCache (optional)
    storefrontModel,
    companyPageModel,
  );

  return {
    service,
    profileModel,
    userModel,
    listingModel,
    postModel,
    jobModel,
    storefrontModel,
    companyPageModel,
    connectProfileService,
    meili,
    erpLinkService,
    allowanceService,
  };
}

// ── Vertical: People / Profiles ───────────────────────────────────────────────

describe('CHECKLIST §6 — Index freshness: People / Profiles vertical', () => {
  describe('CREATE / EDIT a profile — entity is upserted and findable', () => {
    it('handleProfileChanged upserts a public profile into connect_people', async () => {
      const { service, meili, userModel, profileModel } = build();
      const userId = new Types.ObjectId().toHexString();

      userModel.findById = vi.fn(() => chain({ name: 'Asha' }));
      profileModel.findOne = vi.fn(() =>
        chain({
          headline: 'Zari karigar',
          skills: ['zari'],
          visibility: 'public',
          district: 'Surat',
          openTo: { work: true, hiring: false, customOrders: false },
          experience: [],
          services: [],
        }),
      );

      // Simulate the event the profile service emits on create or edit.
      await service.handleProfileChanged({ userId });

      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
      const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(indexName).toBe('connect_people');
      expect(doc.id).toBe(userId);
      expect(doc.headline).toBe('Zari karigar');
      expect(doc.district).toBe('surat'); // lowercased
      expect(doc.openToWork).toBe(true);
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('after an EDIT, the updated headline is present in the new document', async () => {
      const { service, meili, userModel, profileModel } = build();
      const userId = new Types.ObjectId().toHexString();

      userModel.findById = vi.fn(() => chain({ name: 'Asha' }));
      // Simulate an edit: headline changed to 'Senior zari karigar'.
      profileModel.findOne = vi.fn(() =>
        chain({
          headline: 'Senior zari karigar',
          skills: ['zari', 'zardozi'],
          visibility: 'public',
          district: 'Surat',
          openTo: {},
          experience: [],
          services: [],
        }),
      );

      await service.handleProfileChanged({ userId });

      const [, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(doc.headline).toBe('Senior zari karigar');
      // Stale term no longer the only skill — the edit is reflected.
      expect(doc.skills).toContain('zardozi');
    });
  });

  describe('DELETE / hide a profile — entity is removed (no ghost)', () => {
    it('a hidden profile is deleted from the index, not upserted', async () => {
      const { service, meili, userModel, profileModel } = build();
      const userId = new Types.ObjectId().toHexString();

      userModel.findById = vi.fn(() => chain({ name: 'Hidden' }));
      profileModel.findOne = vi.fn(() => chain({ visibility: 'hidden' }));

      await service.handleProfileChanged({ userId });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.deleteDocument).toHaveBeenCalledWith('connect_people', userId);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a connections-visibility profile is deleted from the index', async () => {
      const { service, meili, userModel, profileModel } = build();
      const userId = new Types.ObjectId().toHexString();

      userModel.findById = vi.fn(() => chain({ name: 'Semi-private' }));
      profileModel.findOne = vi.fn(() => chain({ visibility: 'connections' }));

      await service.handleProfileChanged({ userId });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a missing user (erased account) causes a delete from the index', async () => {
      const { service, meili, userModel } = build();
      const userId = new Types.ObjectId().toHexString();

      // User row deleted (erasure).
      userModel.findById = vi.fn(() => chain(null));

      await service.handleProfileChanged({ userId });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });

  describe('BAN a user — their person card is removed from the index', () => {
    it('a missing ConnectProfile (banned/erased) causes a delete from the index', async () => {
      const { service, meili, userModel, profileModel } = build();
      const userId = new Types.ObjectId().toHexString();

      userModel.findById = vi.fn(() => chain({ name: 'Banned' }));
      // Profile removed when account is banned.
      profileModel.findOne = vi.fn(() => chain(null));

      await service.handleProfileChanged({ userId });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });
});

// ── Vertical: Marketplace Listings ───────────────────────────────────────────

describe('CHECKLIST §6 — Index freshness: Listings vertical', () => {
  describe('CREATE / EDIT / PUBLISH a listing — entity is upserted', () => {
    it('handleListingChanged upserts an active+approved listing into connect_listings', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() =>
        chain({
          _id: listingId,
          ownerUserId: new Types.ObjectId(),
          title: 'Zari saree',
          description: 'Heavy work',
          category: 'embroidery-zari',
          priceType: 'fixed',
          priceMin: 5000,
          priceMax: null,
          status: 'active',
          moderationStatus: 'approved',
          location: { district: 'Surat' },
          images: ['a.jpg'],
          createdAt: new Date('2026-01-01'),
        }),
      );

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
      const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(indexName).toBe('connect_listings');
      expect(doc.title).toBe('Zari saree');
      expect(doc.status).toBe('active');
      expect(doc.moderationStatus).toBe('approved');
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('after an EDIT, the updated title is reflected in the upserted document', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() =>
        chain({
          _id: listingId,
          ownerUserId: new Types.ObjectId(),
          title: 'Updated: Premium zardozi work', // title was edited
          description: 'New description',
          category: 'embroidery-zari',
          priceType: 'fixed',
          priceMin: 7000,
          status: 'active',
          moderationStatus: 'approved',
          location: { district: 'Surat' },
          images: [],
          createdAt: new Date(),
        }),
      );

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      const [, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(doc.title).toBe('Updated: Premium zardozi work');
      expect(doc.priceMin).toBe(7000);
    });
  });

  describe('DELETE / UNPUBLISH a listing — entity is removed (no ghost)', () => {
    it('a missing listing (deleted) is removed from the index', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() => chain(null));

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.deleteDocument).toHaveBeenCalledWith(
        'connect_listings',
        listingId.toHexString(),
      );
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a paused (unpublished) listing is removed from the index — not upserted', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() =>
        chain({
          _id: listingId,
          status: 'paused', // unpublished
          moderationStatus: 'approved',
          title: 'x',
          category: 'weaving',
          priceType: 'negotiable',
          ownerUserId: new Types.ObjectId(),
          location: {},
          images: [],
        }),
      );

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a draft / pending listing is removed from the index', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() =>
        chain({
          _id: listingId,
          status: 'active',
          moderationStatus: 'pending', // not yet approved
          title: 'x',
          category: 'weaving',
          priceType: 'negotiable',
          ownerUserId: new Types.ObjectId(),
          location: {},
          images: [],
        }),
      );

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a rejected listing is removed from the index (moderation-down)', async () => {
      const { service, meili, listingModel } = build();
      const listingId = new Types.ObjectId();

      listingModel.findById = vi.fn(() =>
        chain({
          _id: listingId,
          status: 'active',
          moderationStatus: 'rejected', // moderated down
          title: 'x',
          category: 'weaving',
          priceType: 'negotiable',
          ownerUserId: new Types.ObjectId(),
          location: {},
          images: [],
        }),
      );

      await service.handleListingChanged({ listingId: listingId.toHexString() });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });

  describe('BAN seller — their listing is removed from search results at hydration', () => {
    /**
     * Listing indexing is separate from ban handling:
     * - The INDEX itself does not get immediately updated on a ban (no direct
     *   de-index of listings on ban — that is the SRCH-LEAK-1 gap the
     *   `inactiveOwnerIds` author-active gate closes).
     * - The `inactiveOwnerIds` gate (in `searchListings`) drops the banned
     *   seller's listings AT HYDRATION TIME from live `User.isActive`.
     * - These tests confirm the hydration gate works, not the index event.
     *
     * The searchListings test for SRCH-LEAK-1 in search.service.vitest.ts
     * already covers this path extensively. Here we confirm the gate contract
     * by verifying the underlying author-active logic via `searchListings`:
     * a banned seller (not returned by the active-user lookup) has their
     * listing dropped.
     */
    it('SRCH-LEAK-1: searchListings drops a listing whose owner is inactive (no ghost in results)', async () => {
      const { service: svc, listingModel, userModel } = build(false);

      const bannedOwner = new Types.ObjectId();
      const activeOwner = new Types.ObjectId();
      const bannedListingId = new Types.ObjectId();
      const activeListingId = new Types.ObjectId();

      let scanCall = 0;
      listingModel.find = vi.fn(() => {
        scanCall += 1;
        if (scanCall === 1) {
          // ID scan returns both listings.
          return chain([{ _id: bannedListingId }, { _id: activeListingId }]);
        }
        // Hydration returns both listing docs (both still active+approved in Mongo).
        return chain([
          {
            _id: bannedListingId,
            ownerUserId: bannedOwner,
            title: 'Banned seller shop',
            description: 'x',
            category: 'weaving',
            priceType: 'negotiable',
            status: 'active',
            moderationStatus: 'approved',
            location: {},
            images: [],
            createdAt: new Date(),
          },
          {
            _id: activeListingId,
            ownerUserId: activeOwner,
            title: 'Active seller shop',
            description: 'x',
            category: 'weaving',
            priceType: 'negotiable',
            status: 'active',
            moderationStatus: 'approved',
            location: {},
            images: [],
            createdAt: new Date(),
          },
        ]);
      });

      // Only the active owner comes back as `isActive=true`; banned owner is absent.
      userModel.find = vi.fn(() => chain([{ _id: activeOwner }]));

      const result = await svc.searchListings('weaving');

      expect(result.listings.map((l) => l.title)).toEqual(['Active seller shop']);
      expect(result.listings.map((l) => l.title)).not.toContain('Banned seller shop');
    });
  });
});

// ── Vertical: Posts ───────────────────────────────────────────────────────────

describe('CHECKLIST §6 — Index freshness: Posts vertical', () => {
  describe('CREATE / EDIT a post — entity is upserted', () => {
    it('handlePostChanged upserts a public original post into connect_posts', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() =>
        chain({
          _id: postId,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'Heavy zari work on silk saree',
          hashtags: ['zari'],
          visibility: 'public',
          deletedAt: null,
          repostOf: null,
          reactionCount: 5,
          commentCount: 2,
          repostCount: 1,
        }),
      );

      await service.handlePostChanged({ postId: postId.toHexString(), change: 'created' });

      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
      const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(indexName).toBe('connect_posts');
      expect(doc.body).toBe('Heavy zari work on silk saree');
      expect(doc.hashtags).toContain('zari');
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('after an EDIT, the updated body is reflected in the upserted document', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() =>
        chain({
          _id: postId,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'Edited: now includes kanjivaram saree', // body changed
          hashtags: ['kanjivaram'],
          visibility: 'public',
          deletedAt: null,
          repostOf: null,
          reactionCount: 0,
          commentCount: 0,
          repostCount: 0,
        }),
      );

      await service.handlePostChanged({ postId: postId.toHexString(), change: 'edited' });

      const [, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(doc.body).toContain('kanjivaram saree');
      expect(doc.hashtags).toContain('kanjivaram');
    });
  });

  describe('DELETE a post — entity is removed (no ghost)', () => {
    it('a soft-deleted post (deletedAt set) is removed from the index', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() =>
        chain({
          _id: postId,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'deleted post',
          hashtags: [],
          visibility: 'public',
          deletedAt: new Date(), // soft-deleted
          repostOf: null,
          reactionCount: 0,
          commentCount: 0,
          repostCount: 0,
        }),
      );

      await service.handlePostChanged({ postId: postId.toHexString(), change: 'deleted' });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.deleteDocument).toHaveBeenCalledWith('connect_posts', postId.toHexString());
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a missing post (hard-deleted) is removed from the index', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() => chain(null));

      await service.handlePostChanged({ postId: postId.toHexString(), change: 'deleted' });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });

  describe('UNPUBLISH / make-private a post — no ghost in search', () => {
    it('a post made private (visibility changed) is removed from the index', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() =>
        chain({
          _id: postId,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'now private',
          hashtags: [],
          visibility: 'connections', // was public, now connections-only
          deletedAt: null,
          repostOf: null,
          reactionCount: 0,
          commentCount: 0,
          repostCount: 0,
        }),
      );

      await service.handlePostChanged({
        postId: postId.toHexString(),
        change: 'visibility_changed',
      });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a repost entry is not indexed (only originals are searchable)', async () => {
      const { service, meili, postModel } = build();
      const postId = new Types.ObjectId();

      postModel.findById = vi.fn(() =>
        chain({
          _id: postId,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'repost body',
          hashtags: [],
          visibility: 'public',
          deletedAt: null,
          repostOf: new Types.ObjectId().toHexString(), // is a repost
          reactionCount: 0,
          commentCount: 0,
          repostCount: 0,
        }),
      );

      await service.handlePostChanged({ postId: postId.toHexString(), change: 'created' });

      // A repost is treated as "remove from index" (same as non-public).
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });
});

// ── Vertical: Jobs ────────────────────────────────────────────────────────────

describe('CHECKLIST §6 — Index freshness: Jobs vertical', () => {
  describe('CREATE / EDIT / OPEN a job — entity is upserted', () => {
    it('handleJobChanged upserts an open job into connect_jobs', async () => {
      const { service, meili, jobModel } = build();
      const jobId = new Types.ObjectId();

      jobModel.findById = vi.fn(() =>
        chain({
          _id: jobId,
          title: 'Zari karigar wanted',
          description: 'Daily wage work',
          category: 'embroidery-zari',
          role: 'karigar',
          companyUserId: new Types.ObjectId(),
          companyPageId: null,
          location: { district: 'Surat' },
          status: 'open',
          createdAt: new Date(),
        }),
      );

      await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'created' });

      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
      const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(indexName).toBe('connect_jobs');
      expect(doc.title).toBe('Zari karigar wanted');
      expect(doc.district).toBe('Surat');
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('after an EDIT, the updated title is reflected in the upserted document', async () => {
      const { service, meili, jobModel } = build();
      const jobId = new Types.ObjectId();

      jobModel.findById = vi.fn(() =>
        chain({
          _id: jobId,
          title: 'Urgent: embroidery machine operator needed',
          description: 'Piece-rate work',
          category: 'embroidery-machine',
          companyUserId: new Types.ObjectId(),
          companyPageId: null,
          location: { district: 'Surat' },
          status: 'open',
          createdAt: new Date(),
        }),
      );

      await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'edited' });

      const [, [doc]] = meili.upsertDocuments.mock.calls[0];
      expect(doc.title).toBe('Urgent: embroidery machine operator needed');
      expect(doc.category).toBe('embroidery-machine');
    });
  });

  describe('CLOSE / FILL / DELETE a job — entity is removed (no ghost)', () => {
    it('a closed job is removed from the index', async () => {
      const { service, meili, jobModel } = build();
      const jobId = new Types.ObjectId();

      jobModel.findById = vi.fn(() =>
        chain({
          _id: jobId,
          title: 'Karigar',
          category: 'weaving',
          companyUserId: new Types.ObjectId(),
          status: 'closed', // closed
          createdAt: new Date(),
        }),
      );

      await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'closed' });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.deleteDocument).toHaveBeenCalledWith('connect_jobs', jobId.toHexString());
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a filled job is removed from the index', async () => {
      const { service, meili, jobModel } = build();
      const jobId = new Types.ObjectId();

      jobModel.findById = vi.fn(() =>
        chain({
          _id: jobId,
          title: 'Karigar',
          category: 'weaving',
          companyUserId: new Types.ObjectId(),
          status: 'filled', // filled
          createdAt: new Date(),
        }),
      );

      await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'filled' });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('a missing job (deleted) is removed from the index', async () => {
      const { service, meili, jobModel } = build();
      const jobId = new Types.ObjectId();

      jobModel.findById = vi.fn(() => chain(null));

      await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'deleted' });

      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });

  describe('BAN employer — their jobs are dropped at hydration (SRCH-LEAK-1)', () => {
    it('searchJobs drops a job whose company account is inactive (banned/erased)', async () => {
      const { service: svc, jobModel, userModel } = build(false);

      const bannedCompany = new Types.ObjectId();
      const activeCompany = new Types.ObjectId();
      const bannedJobId = new Types.ObjectId();
      const activeJobId = new Types.ObjectId();

      const makeJob = (id: Types.ObjectId, company: Types.ObjectId, title: string) => ({
        _id: id,
        companyUserId: company,
        companyPageId: null,
        title,
        description: 'x',
        category: 'weaving',
        wageType: 'daily',
        wageMin: 500,
        wageMax: 700,
        openings: 1,
        location: { district: 'Surat' },
        status: 'open',
        applicationsCount: 0,
        boostCampaignId: null,
      });

      let scanCall = 0;
      jobModel.find = vi.fn(() => {
        scanCall += 1;
        if (scanCall === 1) {
          return chain([{ _id: bannedJobId }, { _id: activeJobId }]);
        }
        return chain([
          makeJob(bannedJobId, bannedCompany, 'Banned company job'),
          makeJob(activeJobId, activeCompany, 'Active company job'),
        ]);
      });

      // Only the active company is returned by the author-active gate.
      userModel.find = vi.fn(() => chain([{ _id: activeCompany }]));

      const result = await svc.searchJobs('karigar');

      expect(result.jobs.map((j) => j.title)).toEqual(['Active company job']);
      expect(result.jobs.map((j) => j.title)).not.toContain('Banned company job');
    });
  });
});

// ── Vertical: Storefronts (SRCH-VERT-1) ──────────────────────────────────────

describe('CHECKLIST §6 — Index freshness: Storefronts vertical (SRCH-VERT-1)', () => {
  it('handleStorefrontChanged upserts a public storefront into connect_storefronts', async () => {
    const { service, meili, storefrontModel } = build();
    const storefrontId = new Types.ObjectId();

    storefrontModel.findById = vi.fn(() =>
      chain({
        _id: storefrontId,
        ownerUserId: new Types.ObjectId(),
        name: 'Rajesh Zari Shop',
        slug: 'rajesh-zari-shop',
        description: 'Heavy zari work',
        categories: ['Embroidery'],
        location: { district: 'Surat' },
        visibility: 'public',
        createdAt: new Date('2026-01-01'),
      }),
    );

    await service.handleStorefrontChanged({ storefrontId: storefrontId.toHexString() });

    expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
    const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
    expect(indexName).toBe('connect_storefronts');
    expect(doc.name).toBe('Rajesh Zari Shop');
    expect(doc.district).toBe('surat'); // lowercased
    expect(doc.categories).toEqual(['embroidery']); // lowercased
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });

  it('a hidden storefront is removed from the index (no ghost)', async () => {
    const { service, meili, storefrontModel } = build();
    const storefrontId = new Types.ObjectId();

    storefrontModel.findById = vi.fn(() =>
      chain({
        _id: storefrontId,
        ownerUserId: new Types.ObjectId(),
        name: 'Secret shop',
        slug: 'secret',
        visibility: 'hidden', // not public
        location: {},
      }),
    );

    await service.handleStorefrontChanged({ storefrontId: storefrontId.toHexString() });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    expect(meili.deleteDocument).toHaveBeenCalledWith(
      'connect_storefronts',
      storefrontId.toHexString(),
    );
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
  });

  it('a missing storefront (deleted) is removed from the index', async () => {
    const { service, meili, storefrontModel } = build();
    const storefrontId = new Types.ObjectId();

    storefrontModel.findById = vi.fn(() => chain(null));

    await service.handleStorefrontChanged({ storefrontId: storefrontId.toHexString() });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
  });
});

// ── Vertical: Company / Institute Pages (SRCH-VERT-1) ─────────────────────────

describe('CHECKLIST §6 — Index freshness: Pages vertical (SRCH-VERT-1)', () => {
  it('handleCompanyPageChanged upserts a public page into connect_pages with its kind', async () => {
    const { service, meili, companyPageModel } = build();
    const pageId = new Types.ObjectId();

    companyPageModel.findById = vi.fn(() =>
      chain({
        _id: pageId,
        ownerUserId: new Types.ObjectId(),
        name: 'Surat Embroidery Institute',
        slug: 'surat-embroidery-institute',
        kind: 'institute',
        about: 'We train karigars',
        industryPanel: { specialization: [] },
        institutePanel: { coursesOffered: ['Computerised Embroidery'] },
        location: { district: 'Surat' },
        visibility: 'public',
        createdAt: new Date('2026-01-01'),
      }),
    );

    await service.handleCompanyPageChanged({ companyPageId: pageId.toHexString() });

    expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
    const [indexName, [doc]] = meili.upsertDocuments.mock.calls[0];
    expect(indexName).toBe('connect_pages');
    expect(doc.name).toBe('Surat Embroidery Institute');
    expect(doc.kind).toBe('institute');
    expect(doc.tags).toContain('computerised embroidery'); // course name -> searchable tag
    expect(doc.district).toBe('surat'); // lowercased
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });

  it('a hidden page is removed from the index (no ghost)', async () => {
    const { service, meili, companyPageModel } = build();
    const pageId = new Types.ObjectId();

    companyPageModel.findById = vi.fn(() =>
      chain({
        _id: pageId,
        ownerUserId: new Types.ObjectId(),
        name: 'Hidden co',
        slug: 'hidden-co',
        kind: 'business',
        visibility: 'connections', // not public
        location: {},
      }),
    );

    await service.handleCompanyPageChanged({ companyPageId: pageId.toHexString() });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    expect(meili.deleteDocument).toHaveBeenCalledWith('connect_pages', pageId.toHexString());
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
  });

  it('a missing page (deleted) is removed from the index', async () => {
    const { service, meili, companyPageModel } = build();
    const pageId = new Types.ObjectId();

    companyPageModel.findById = vi.fn(() => chain(null));

    await service.handleCompanyPageChanged({ companyPageId: pageId.toHexString() });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
  });
});

// ── Event hook wiring: confirming the @OnEvent handler is the entry point ─────

describe('CHECKLIST §6 — Event hook wiring: @OnEvent handlers trigger re-index', () => {
  /**
   * These tests call the event-handler methods directly (the @OnEvent decorator
   * is metadata-only and does not affect the method signature). This proves the
   * full path from event emission → re-index in a single test, giving end-to-end
   * freshness coverage without needing the NestJS event-emitter module.
   */
  it('handleProfileChanged is the @OnEvent entry point for profile create/update', async () => {
    const { service, meili, userModel, profileModel } = build();
    const userId = new Types.ObjectId().toHexString();

    userModel.findById = vi.fn(() => chain({ name: 'X' }));
    profileModel.findOne = vi.fn(() =>
      chain({
        visibility: 'public',
        headline: 'karigar',
        skills: [],
        openTo: {},
        experience: [],
        services: [],
      }),
    );

    await service.handleProfileChanged({ userId });

    // Confirm upsert was triggered (not a no-op).
    expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
  });

  it('handleListingChanged is the @OnEvent entry point for listing create/edit/publish/unpublish', async () => {
    const { service, meili, listingModel } = build();
    const listingId = new Types.ObjectId();

    // Simulate a delete (most unambiguous signal of event wiring).
    listingModel.findById = vi.fn(() => chain(null));

    await service.handleListingChanged({ listingId: listingId.toHexString() });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
  });

  it('handlePostChanged is the @OnEvent entry point for post create/edit/delete', async () => {
    const { service, meili, postModel } = build();
    const postId = new Types.ObjectId();

    postModel.findById = vi.fn(() => chain(null));

    await service.handlePostChanged({ postId: postId.toHexString(), change: 'deleted' });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
  });

  it('handleJobChanged is the @OnEvent entry point for job create/close/fill', async () => {
    const { service, meili, jobModel } = build();
    const jobId = new Types.ObjectId();

    jobModel.findById = vi.fn(() => chain(null));

    await service.handleJobChanged({ jobId: jobId.toHexString(), change: 'deleted' });

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
  });
});

// ── Meili-disabled no-op: writes when Meili is off must not crash ─────────────

describe('CHECKLIST §6 — Index freshness: no-op when Meilisearch is disabled', () => {
  it('indexPerson is a no-op when Meili is disabled', async () => {
    const { service, meili } = build(false);
    await service.indexPerson(new Types.ObjectId().toHexString());
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });

  it('indexListing is a no-op when Meili is disabled', async () => {
    const { service, meili } = build(false);
    await service.indexListing(new Types.ObjectId().toHexString());
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });

  it('indexPost is a no-op when Meili is disabled', async () => {
    const { service, meili } = build(false);
    await service.indexPost(new Types.ObjectId().toHexString());
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });

  it('indexJob is a no-op when Meili is disabled', async () => {
    const { service, meili } = build(false);
    await service.indexJob(new Types.ObjectId().toHexString());
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
    expect(meili.deleteDocument).not.toHaveBeenCalled();
  });
});
