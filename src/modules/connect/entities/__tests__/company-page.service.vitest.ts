/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompanyPageService } from '../services/company-page.service';

const OWNER = '60b0000000000000000000a1';
const OTHER = '60b0000000000000000000a2';
const WS = '60b0000000000000000000c1';

function makeModel() {
  const created: any[] = [];
  let listed: any[] = [];
  let findByIdDoc: any = null;
  let findOneDoc: any = null;
  let count = 0;
  let lastFilter: any = null;
  // browse() runs two $facet specialization/district aggregations (added by d8646c1);
  // default to an empty result so non-facet browse asserts don't care, with a setter
  // mirroring setListed/setCount for tests that want to seed facet rows.
  let aggregateRows: any[] = [];
  const model: any = {
    _created: created,
    setListed: (rows: any[]) => (listed = rows),
    setFindById: (doc: any) => (findByIdDoc = doc),
    setFindOne: (doc: any) => (findOneDoc = doc),
    setCount: (n: number) => (count = n),
    setAggregate: (rows: any[]) => (aggregateRows = rows),
    getLastFilter: () => lastFilter,
    countDocuments: vi.fn(async () => count),
    aggregate: vi.fn(async () => aggregateRows),
    exists: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, any>) => {
      const doc = {
        ...input,
        _id: `cp-${created.length + 1}`,
        save: vi.fn(() => Promise.resolve()),
      };
      created.push(doc);
      return doc;
    }),
    // Chainable so it serves both `listMine` (sort->lean->exec) and `browse`
    // (sort->skip->limit->select->lean->exec). Captures the filter for asserts.
    find: vi.fn((filter: any) => {
      lastFilter = filter;
      const chain: any = {
        sort: () => chain,
        skip: () => chain,
        limit: () => chain,
        select: () => chain,
        lean: () => chain,
        exec: async () => listed,
      };
      return chain;
    }),
    findById: vi.fn(async () => findByIdDoc),
    findOne: vi.fn(() => ({ lean: () => ({ exec: async () => findOneDoc }) })),
  };
  return model;
}

function makeSvc(opts?: {
  allowThrows?: boolean;
  erp?: { linked: boolean; since: Date | null };
  /** Owner of the workspace the link tests target (ADR-0004 ownership check). */
  wsOwner?: string | null;
}) {
  const model = makeModel();
  const allowances = {
    assertCanCreateCompanyPage: vi.fn(async () => {
      if (opts?.allowThrows) throw new ForbiddenException('cap');
    }),
  };
  const erpStatus = () => opts?.erp ?? { linked: true, since: new Date('2026-01-01') };
  const erpLink = {
    getWorkspaceStatus: vi.fn(async () => erpStatus()),
    // Consent gate (ADR-0004): mirror the real wrapper — unlinked unless the
    // entity's own `erpLink.status === 'verified'` and a workspace pointer is set.
    getConsentedWorkspaceStatus: vi.fn(async (entity: any) =>
      entity?.erpLink?.status === 'verified' && entity?.erpWorkspaceId
        ? erpStatus()
        : { linked: false, since: null, signals: { attendance: 0, payrollRuns: 0, invoices: 0 } },
    ),
  };
  const audit = { logEvent: vi.fn(() => Promise.resolve()) };
  const posthog = { capture: vi.fn() };
  const media: any = {
    assertOwnedMedia: vi.fn(() => Promise.resolve()),
    assertOwnedSingle: vi.fn(() => Promise.resolve()),
    getServerVideoDurationByUrl: vi.fn(() => Promise.resolve(45 as number | null)),
  };
  // Workspace model for the ownership-checked link path (ADR-0004). Returns a
  // workspace whose `ownerId` is `wsOwner` (default OWNER), or null when set null.
  const wsOwner = opts?.wsOwner === undefined ? OWNER : opts.wsOwner;
  const workspaceModel: any = {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () => ({ exec: async () => (wsOwner ? { ownerId: wsOwner } : null) }),
      }),
    })),
  };
  const svc = new CompanyPageService(
    model,
    allowances as any,
    erpLink as any,
    audit as any,
    posthog as any,
    undefined, // reviews (optional)
    // Media-ownership guard stub so create/update logo/banner checks no-op in unit tests.
    // `getServerVideoDurationByUrl` mirrors the listing suite's stub (server-derived
    // clip length, the source of truth stamped onto each stored video); default 45s
    // (within the 60s upload cap). Spies (vi.fn) so tests can assert the guard calls.
    media,
    undefined, // overLimit (optional)
    undefined, // events (optional)
    workspaceModel, // ADR-0004 ownership check for linkErpWorkspace
  );
  return { svc, model, allowances, erpLink, audit, posthog, media, workspaceModel };
}

describe('CompanyPageService', () => {
  it('create: gates on the cap, derives a slug, persists, audits + emits', async () => {
    const { svc, model, allowances, audit, posthog } = makeSvc();
    const doc = await svc.create(OWNER, { name: 'Rajesh Textiles' });

    expect(allowances.assertCanCreateCompanyPage).toHaveBeenCalledWith(OWNER, 0);
    expect((doc as any).slug).toBe('rajesh-textiles');
    expect(model.create).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'company_page_created', actorId: OWNER }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.company_page_created' }),
    );
  });

  it('create: defaults kind to business + empty institutePanel when not an institute', async () => {
    const { svc, model } = makeSvc();
    await svc.create(OWNER, { name: 'Rajesh Textiles' });
    const persisted = model.create.mock.calls[0][0];
    expect(persisted.kind).toBe('business');
    expect(persisted.institutePanel).toEqual({});
  });

  it('create: persists an institute page with its institutePanel', async () => {
    const { svc, model } = makeSvc();
    const doc = await svc.create(OWNER, {
      name: 'Surat Stitch Academy',
      kind: 'institute',
      institutePanel: {
        coursesOffered: ['Computerised Embroidery', 'Saree Draping'],
        modes: ['offline'],
        languages: ['gu', 'hi'],
      },
    } as any);
    const persisted = model.create.mock.calls[0][0];
    expect(persisted.kind).toBe('institute');
    expect(persisted.institutePanel).toEqual({
      coursesOffered: ['Computerised Embroidery', 'Saree Draping'],
      modes: ['offline'],
      languages: ['gu', 'hi'],
    });
    expect((doc as any).kind).toBe('institute');
  });

  it('update: applies kind + merges institutePanel', async () => {
    const { svc, model } = makeSvc();
    const doc: any = {
      _id: 'cp-1',
      ownerUserId: OWNER,
      logo: '',
      banner: '',
      kind: 'business',
      institutePanel: { coursesOffered: ['Old Course'], modes: [], languages: ['gu'] },
      save: vi.fn(() => Promise.resolve()),
    };
    model.setFindById(doc);
    await svc.update(OWNER, 'cp-1', {
      kind: 'institute',
      institutePanel: { modes: ['online', 'offline'] },
    } as any);
    expect(doc.kind).toBe('institute');
    // Merge keeps the untouched coursesOffered + languages, overrides modes.
    expect(doc.institutePanel).toEqual({
      coursesOffered: ['Old Course'],
      modes: ['online', 'offline'],
      languages: ['gu'],
    });
  });

  it('create: propagates the allowance cap rejection', async () => {
    const { svc, model } = makeSvc({ allowThrows: true });
    await expect(svc.create(OWNER, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('listMine returns the owner rows', async () => {
    const { svc, model } = makeSvc();
    model.setListed([{ _id: 'cp-1', name: 'A' }]);
    const rows = await svc.listMine(OWNER);
    expect(rows).toHaveLength(1);
  });

  it('getMine 404s for a non-owner', async () => {
    const { svc, model } = makeSvc();
    model.setFindById({ _id: 'cp-9', ownerUserId: OTHER });
    await expect(svc.getMine(OWNER, 'cp-9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update applies fields + audits', async () => {
    const { svc, model, audit } = makeSvc();
    const doc: any = {
      _id: 'cp-1',
      ownerUserId: OWNER,
      name: 'Old',
      save: vi.fn(() => Promise.resolve()),
    };
    model.setFindById(doc);
    await svc.update(OWNER, 'cp-1', { name: 'New' });
    expect(doc.name).toBe('New');
    expect(doc.save).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'company_page_updated' }),
    );
  });

  // --- Company-page intro video (mirrors the marketplace listing video suite) ---
  // The clip carries a server-derived durationSec; the 60s length cap lives in the
  // uploads media-probe (`connect-company-video` policy duration.max=60), NOT this
  // service, so a 90s clip is rejected at upload time (same layer as the listing
  // clip) and the "second video" cap is the DTO `@ArrayMaxSize(1)`.
  describe('video (intro clip)', () => {
    it('create: persists an owned video + stamps the SERVER-derived durationSec', async () => {
      const { svc, media } = makeSvc();
      media.getServerVideoDurationByUrl.mockResolvedValue(45);
      const doc = await svc.create(OWNER, {
        name: 'Rajesh Textiles',
        videos: [{ url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg' }],
      } as any);
      // url + posterUrl both flattened into one ownership-guard call.
      const ownArg = media.assertOwnedMedia.mock.calls.find((c: any[]) =>
        (c[0] as string[]).includes('https://cdn/clip.mp4'),
      );
      expect(ownArg?.[0]).toEqual(
        expect.arrayContaining(['https://cdn/clip.mp4', 'https://cdn/poster.jpg']),
      );
      expect((doc as any).videos).toEqual([
        { url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg', durationSec: 45 },
      ]);
    });

    it('create: rejects a video URL the caller does not own (no persist)', async () => {
      const { svc, model, media } = makeSvc();
      media.assertOwnedMedia.mockImplementation((urls: any[]) => {
        if ((urls as string[]).includes('https://cdn/foreign.mp4')) {
          return Promise.reject(new Error('not yours'));
        }
        return Promise.resolve();
      });
      await expect(
        svc.create(OWNER, {
          name: 'X',
          videos: [{ url: 'https://cdn/foreign.mp4' }],
        } as any),
      ).rejects.toThrow();
      expect(model.create).not.toHaveBeenCalled();
    });

    it('create: leaves videos empty (unchanged) when none submitted (no duration probe)', async () => {
      const { svc, model, media } = makeSvc();
      const doc = await svc.create(OWNER, { name: 'No Clip Co' } as any);
      expect((doc as any).videos).toEqual([]);
      // model.create was called with videos: [] (additive empty default).
      expect(model.create.mock.calls[0][0].videos).toEqual([]);
      expect(media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
    });

    it('update: keeps the existing video (grandfathered) + re-stamps durationSec', async () => {
      const { svc, model, media } = makeSvc();
      const existingVideo = { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg' };
      const doc: any = {
        _id: 'cp-1',
        ownerUserId: OWNER,
        logo: '',
        banner: '',
        videos: [existingVideo],
        save: vi.fn(() => Promise.resolve()),
      };
      model.setFindById(doc);
      media.getServerVideoDurationByUrl.mockResolvedValue(30);
      await svc.update(OWNER, 'cp-1', { videos: [existingVideo] } as any);
      // Ownership guard grandfathers the existing clip url + poster.
      const videoOwnCall = media.assertOwnedMedia.mock.calls.find((c: any[]) =>
        (c[0] as string[]).includes('https://cdn/old.mp4'),
      );
      expect(videoOwnCall?.[2]?.grandfatheredUrls).toEqual(
        expect.arrayContaining(['https://cdn/old.mp4', 'https://cdn/oldposter.jpg']),
      );
      expect(doc.videos).toEqual([
        { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg', durationSec: 30 },
      ]);
    });

    it('update: leaves the existing video untouched when videos is omitted', async () => {
      const { svc, model, media } = makeSvc();
      const doc: any = {
        _id: 'cp-1',
        ownerUserId: OWNER,
        logo: '',
        banner: '',
        videos: [{ url: 'https://cdn/keep.mp4', durationSec: 20 }],
        save: vi.fn(() => Promise.resolve()),
      };
      model.setFindById(doc);
      await svc.update(OWNER, 'cp-1', { name: 'Renamed' } as any);
      expect(doc.videos).toEqual([{ url: 'https://cdn/keep.mp4', durationSec: 20 }]);
      expect(media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
    });
  });

  it('remove deletes + audits', async () => {
    const { svc, model, audit } = makeSvc();
    const doc: any = { _id: 'cp-1', ownerUserId: OWNER, deleteOne: vi.fn(() => Promise.resolve()) };
    model.setFindById(doc);
    await svc.remove(OWNER, 'cp-1');
    expect(doc.deleteOne).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'company_page_deleted' }),
    );
  });

  it('getPublicBySlug 404s when missing', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne(null);
    await expect(svc.getPublicBySlug('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPublicBySlug 404s a hidden page to a non-owner', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne({ _id: 'cp-1', ownerUserId: OWNER, visibility: 'hidden', slug: 'h' });
    await expect(svc.getPublicBySlug('h')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPublicBySlug derives the ERP badge for a verified link, trims to {linked, since}', async () => {
    const since = new Date('2026-01-01');
    const { svc, model, erpLink } = makeSvc({ erp: { linked: true, since } });
    // ADR-0004: badge derives only through the consent-gated wrapper, and only
    // when the page's own erpLink.status is 'verified'.
    model.setFindOne({
      _id: 'cp-1',
      ownerUserId: OWNER,
      visibility: 'public',
      slug: 'p',
      erpWorkspaceId: WS,
      erpLink: { status: 'verified' },
    });
    const res = await svc.getPublicBySlug('p');
    expect(erpLink.getConsentedWorkspaceStatus).toHaveBeenCalled();
    expect(res.erpLink).toEqual({ linked: true, since });
  });

  it('getPublicBySlug returns linked:false for a non-verified (revoked) link', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne({
      _id: 'cp-1',
      ownerUserId: OWNER,
      visibility: 'public',
      slug: 'p',
      // Dangling pointer with a revoked link must NOT show the badge.
      erpWorkspaceId: WS,
      erpLink: { status: 'revoked' },
    });
    const res = await svc.getPublicBySlug('p');
    expect(res.erpLink).toEqual({ linked: false, since: null });
  });

  it('getPublicBySlug returns linked:false without an ERP workspace', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne({
      _id: 'cp-1',
      ownerUserId: OWNER,
      visibility: 'public',
      slug: 'p',
      erpWorkspaceId: null,
      erpLink: null,
    });
    const res = await svc.getPublicBySlug('p');
    expect(res.erpLink).toEqual({ linked: false, since: null });
  });

  describe('getRefs (batch identity)', () => {
    it('carries erpLinked:true only for a verified link (consent-gated)', async () => {
      const { svc, model } = makeSvc();
      model.setListed([
        {
          _id: 'cp-1',
          name: 'ERP Co',
          slug: 'erp-co',
          logo: 'l.png',
          erpWorkspaceId: WS,
          erpLink: { status: 'verified' },
        },
        // A dangling pointer with no verified link reads as not-linked (ADR-0004).
        { _id: 'cp-2', name: 'Plain Co', slug: 'plain-co', erpWorkspaceId: WS, erpLink: null },
      ]);
      const refs = await svc.getRefs(['60b0000000000000000000d1', '60b0000000000000000000d2']);
      expect(refs).toEqual([
        { id: 'cp-1', name: 'ERP Co', slug: 'erp-co', logo: 'l.png', erpLinked: true },
        { id: 'cp-2', name: 'Plain Co', slug: 'plain-co', logo: '', erpLinked: false },
      ]);
    });
  });

  describe('searchByName (company-name type-ahead)', () => {
    it('returns public pages whose name matches, capped, hidden excluded', async () => {
      const { svc, model } = makeSvc();
      // The mock find().exec() returns whatever setListed seeds; the service's
      // { name: rx, visibility: 'public' } filter + hidden exclusion is exercised
      // for real against a memory db elsewhere, so here we seed the public rows
      // the query would return and assert the ref-shape mapping + cap.
      model.setListed([
        {
          _id: 'cp-1',
          name: 'Patel Embroidery Works',
          slug: 'patel-embroidery-works',
          logo: 'l.png',
        },
        { _id: 'cp-2', name: 'Patel Looms', slug: 'patel-looms', logo: '' },
      ]);
      const res = await svc.searchByName('patel', 5);
      const names = res.map((r) => r.name);
      expect(names).toContain('Patel Embroidery Works');
      expect(names).not.toContain('Patel Hidden');
      expect(res.length).toBeLessThanOrEqual(5);
      // Filter constrains to public + case-insensitive name regex.
      const f = model.getLastFilter();
      expect(f.visibility).toBe('public');
      expect((f.name as RegExp).source).toBe('patel');
      expect((f.name as RegExp).flags).toContain('i');
      // Returns the same minimal CompanyPageRef shape as getRefs.
      expect(res[0]).toMatchObject({
        id: 'cp-1',
        name: 'Patel Embroidery Works',
        slug: 'patel-embroidery-works',
      });
    });

    it('returns [] for a term shorter than 2 chars', async () => {
      const { svc } = makeSvc();
      expect(await svc.searchByName('p', 5)).toEqual([]);
    });
  });

  describe('browse (public directory)', () => {
    it('restricts to public pages, paginates, and maps card fields', async () => {
      const { svc, model } = makeSvc();
      model.setCount(30);
      // Seed the specialization facet aggregation (both facet pipelines share the
      // mock, so the same rows back the district facet too — harmless here).
      model.setAggregate([{ _id: 'embroidery-zari', count: 8 }]);
      model.setListed([
        {
          _id: 'cp-1',
          ownerUserId: OWNER,
          name: 'Surat Zari Works',
          slug: 'surat-zari-works',
          logo: 'l.png',
          about: '  We do   fine   zari embroidery.  ',
          location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
          industryPanel: { specialization: ['embroidery-zari'] },
        },
      ]);
      const res = await svc.browse({ page: 1, pageSize: 24 });

      expect(model.getLastFilter()).toEqual({ visibility: 'public' });
      expect(res.total).toBe(30);
      expect(res.page).toBe(1);
      expect(res.hasMore).toBe(true); // 1 * 24 < 30
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        id: 'cp-1',
        // Internal owner key the public controller uses for the rating lookup;
        // stripped from the HTTP response by mergeBrowseCounts.
        ownerUserId: OWNER,
        slug: 'surat-zari-works',
        name: 'Surat Zari Works',
        about: 'We do fine zari embroidery.', // whitespace collapsed
        specialization: ['embroidery-zari'],
        // Cross-collection count, defaulted before the controller merge.
        productCount: 0,
      });
      expect(res.items[0].location).toEqual({
        district: 'Surat',
        city: 'Surat',
        state: 'Gujarat',
      });
      // Facet rows from the seeded aggregation are mapped onto the response.
      expect(res.facets.specialization).toContainEqual({ value: 'embroidery-zari', count: 8 });
    });

    it('filters to institutes only when kind=institute, and reports the kind facet', async () => {
      const { svc, model } = makeSvc();
      model.setCount(5);
      // Both facet pipelines share the mock; seed the kind buckets for the test.
      model.setAggregate([
        { _id: 'institute', count: 5 },
        { _id: 'business', count: 20 },
      ]);
      model.setListed([
        {
          _id: 'cp-1',
          ownerUserId: OWNER,
          name: 'Surat Stitch Academy',
          slug: 'surat-stitch-academy',
          kind: 'institute',
        },
      ]);
      const res = await svc.browse({ kind: 'institute' });
      // An institute filter pins kind exactly.
      expect(model.getLastFilter()).toMatchObject({ visibility: 'public', kind: 'institute' });
      expect(res.items[0].kind).toBe('institute');
      // The kind facet rows are mapped onto the response.
      expect(res.facets.kind).toContainEqual({ value: 'institute', count: 5 });
    });

    it('rolls legacy (unset) pages into the business bucket for a kind=business filter', async () => {
      const { svc, model } = makeSvc();
      await svc.browse({ kind: 'business' });
      const f = model.getLastFilter();
      // business matches both an explicit 'business' and a missing field.
      expect(f.kind).toEqual({ $in: ['business', null] });
    });

    it('defaults kind to business on a card when the stored page has no kind', async () => {
      const { svc, model } = makeSvc();
      model.setCount(1);
      model.setListed([{ _id: 'cp-1', ownerUserId: OWNER, name: 'Legacy Co', slug: 'legacy-co' }]);
      const res = await svc.browse({ page: 1, pageSize: 24 });
      expect(res.items[0].kind).toBe('business');
    });

    it('builds a case-insensitive $or for q and an exact specialization filter', async () => {
      const { svc, model } = makeSvc();
      await svc.browse({ q: 'zari', specialization: 'job-work', district: 'Surat' });
      const f = model.getLastFilter();
      expect(f.visibility).toBe('public');
      expect(Array.isArray(f.$or)).toBe(true);
      expect((f.$or[0].name as RegExp).source).toBe('zari');
      expect((f.$or[0].name as RegExp).flags).toContain('i');
      expect(f['industryPanel.specialization']).toBe('job-work');
      expect((f['location.district'] as RegExp).source).toBe('Surat');
    });

    it('escapes regex metacharacters in q (no widened query / throw)', async () => {
      const { svc, model } = makeSvc();
      await svc.browse({ q: 'a.*b' });
      const f = model.getLastFilter();
      expect((f.$or[0].name as RegExp).source).toBe('a\\.\\*b');
    });

    it('clamps pageSize to the max and reports hasMore:false on the last page', async () => {
      const { svc, model } = makeSvc();
      model.setCount(10);
      const res = await svc.browse({ page: 1, pageSize: 999 });
      expect(res.pageSize).toBe(48); // clamped
      expect(res.hasMore).toBe(false); // 1 * 48 >= 10
    });

    it('derives hasVideo true/false on browse cards (no full video objects leaked)', async () => {
      const { svc, model } = makeSvc();
      model.setCount(2);
      model.setListed([
        {
          _id: 'cp-1',
          ownerUserId: OWNER,
          name: 'Clip Co',
          slug: 'clip-co',
          videos: [{ url: 'https://cdn/c.mp4', durationSec: 30 }],
        },
        {
          _id: 'cp-2',
          ownerUserId: OWNER,
          name: 'No Clip Co',
          slug: 'no-clip-co',
          videos: [],
        },
      ]);
      const res = await svc.browse({ page: 1, pageSize: 24 });
      const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
      expect(byId['cp-1'].hasVideo).toBe(true);
      expect(byId['cp-2'].hasVideo).toBe(false);
      // The card carries only the lightweight boolean, never the full video objects.
      expect((byId['cp-1'] as any).videos).toBeUndefined();
    });
  });

  // ── ERP link / unlink (consent + ownership-verified, ADR-0004) ─────────────
  describe('linkErpWorkspace / unlinkErpWorkspace', () => {
    function ownedPageDoc() {
      return {
        _id: 'cp-1',
        ownerUserId: OWNER,
        erpWorkspaceId: null as any,
        erpLink: null as any,
        save: vi.fn(() => Promise.resolve()),
      };
    }

    it('links: sets erpWorkspaceId + verified erpLink when the caller owns the workspace', async () => {
      const { svc, model, audit, workspaceModel } = makeSvc({ wsOwner: OWNER });
      const doc = ownedPageDoc();
      model.setFindById(doc);

      const res = await svc.linkErpWorkspace(OWNER, '60b0000000000000000000d1', WS);

      expect(workspaceModel.findById).toHaveBeenCalledWith(WS);
      expect(String(res.erpWorkspaceId)).toBe(WS);
      expect(res.erpLink).toMatchObject({
        status: 'verified',
        consentVersion: 'erp-verify-v1',
      });
      expect(String(res.erpLink.linkedByUserId)).toBe(OWNER);
      expect(res.erpLink.linkedAt).toBeInstanceOf(Date);
      expect(audit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'company_page_erp_linked' }),
      );
    });

    it('links: throws ForbiddenException when the caller does NOT own the workspace', async () => {
      const { svc, model } = makeSvc({ wsOwner: OTHER });
      const doc = ownedPageDoc();
      model.setFindById(doc);

      await expect(
        svc.linkErpWorkspace(OWNER, '60b0000000000000000000d1', WS),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // No write happened on the rejected link.
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('links: throws ForbiddenException when the workspace does not exist', async () => {
      const { svc, model } = makeSvc({ wsOwner: null });
      model.setFindById(ownedPageDoc());
      await expect(
        svc.linkErpWorkspace(OWNER, '60b0000000000000000000d1', WS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('links: 404s when the caller does not own the page (loadOwned guard)', async () => {
      const { svc, model } = makeSvc({ wsOwner: OWNER });
      model.setFindById({ _id: 'cp-1', ownerUserId: OTHER });
      await expect(
        svc.linkErpWorkspace(OWNER, '60b0000000000000000000d1', WS),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unlinks: clears erpWorkspaceId + flips erpLink to revoked, audited', async () => {
      const { svc, model, audit } = makeSvc();
      const doc = {
        _id: 'cp-1',
        ownerUserId: OWNER,
        erpWorkspaceId: WS as any,
        erpLink: {
          status: 'verified',
          linkedByUserId: OWNER,
          consentVersion: 'erp-verify-v1',
        } as any,
        save: vi.fn(() => Promise.resolve()),
      };
      model.setFindById(doc);

      const res = await svc.unlinkErpWorkspace(OWNER, '60b0000000000000000000d1');

      expect(res.erpWorkspaceId).toBeNull();
      expect(res.erpLink.status).toBe('revoked');
      expect(audit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'company_page_erp_unlinked' }),
      );
    });
  });

  // ── DTO no longer accepts raw erpWorkspaceId on create/update (ADR-0004) ────
  describe('create / update do not silently link ERP', () => {
    it('create never sets erpWorkspaceId from the DTO (a new page is unlinked)', async () => {
      const { svc, model } = makeSvc();
      // Even if a crafted body slipped an erpWorkspaceId past validation, the
      // service ignores it and persists null (link only via linkErpWorkspace).
      await svc.create(OWNER, { name: 'X', erpWorkspaceId: WS } as any);
      const created = model._created[0];
      expect(created.erpWorkspaceId).toBeNull();
      expect(created.erpLink).toBeNull();
    });

    it('update never mutates erpWorkspaceId from the DTO', async () => {
      const { svc, model } = makeSvc();
      const doc = {
        _id: 'cp-1',
        ownerUserId: OWNER,
        erpWorkspaceId: null as any,
        erpLink: null as any,
        logo: '',
        banner: '',
        industryPanel: {},
        institutePanel: {},
        location: {},
        save: vi.fn(() => Promise.resolve()),
      };
      model.setFindById(doc);
      await svc.update(OWNER, '60b0000000000000000000d1', { erpWorkspaceId: WS } as any);
      expect(doc.erpWorkspaceId).toBeNull();
    });
  });
});
