/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (ConnectProfile / CompanyPage / User) skip vitest's reflect-metadata
// pipeline. Mirrors the canonical inquiry.service.vitest.ts pure-unit pattern,
// the same shape the Feature 2 spec uses.
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
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { ConnectProfileService } from '../../profile/connect-profile.service';

/**
 * Unit coverage for the Institutes Phase 2 Feature 3 institute-page PUBLIC reads
 * added to `ConnectProfileService`: `getInstituteAlumni` (Open-to-work tab) +
 * `getInstitutePlacements` ("where our students work" wall) + `loadPublicInstitute`
 * (the page gate). DPDP is the headline: a profile that is hidden / connections-
 * only, or whose matching credential is not opted in (`shareWithInstitute=false`),
 * MUST NOT appear on either surface, and everything is strictly scoped to the
 * given pageId (no cross-institute leakage). Models are mocked; people hydration
 * is the real batched `getPeopleByIds` path (userModel + profileModel $in).
 */

const PAGE_ID = new Types.ObjectId();
const OTHER_PAGE_ID = new Types.ObjectId();
const EMPLOYER_A = new Types.ObjectId();
const EMPLOYER_B = new Types.ObjectId();

/** Fluent query chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    skip: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    populate: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

/**
 * Build a ConnectProfileService with positional stubs. Only the deps the public
 * read path touches are functional: profileModel (find for the alumni/placement
 * scan + the getPeopleByIds headline lookup), userModel (batch identity find),
 * companyPageModel (the page gate + employer/company refs). The rest are harmless
 * stubs. `findOne` defaults to a public institute page so `loadPublicInstitute`
 * passes unless a test overrides it.
 */
function build(opts?: { page?: unknown }) {
  const profileModel: any = {
    find: vi.fn(() => chain([])),
    findOne: vi.fn(() => chain(null)),
    create: vi.fn(),
  };
  const userModel: any = { find: vi.fn(() => chain([])) };
  const eventEmitter: any = { emit: vi.fn() };
  const allowances: any = { getAllowances: vi.fn().mockResolvedValue({ verifiedBadge: false }) };
  const reviews: any = undefined;
  const connectionModel: any = undefined;
  // The institute page gate + the employer/company-ref resolves all read through
  // companyPageModel.findOne (gate) and companyPageModel.find (refs).
  const defaultPage =
    opts && 'page' in opts
      ? opts.page
      : { _id: PAGE_ID, kind: 'institute', visibility: 'public', name: 'Surat Stitch Academy' };
  // The gate query is `{ _id, kind: 'institute', visibility: 'public' }`. Model
  // the DB honestly: a page that does not match that filter resolves to null
  // (so a business / hidden page 404s exactly as Mongo would return no row).
  const companyPageModel: any = {
    findOne: vi.fn((filter: any) => {
      const p = defaultPage as any;
      if (!p) return chain(null);
      const matches =
        (filter?.kind === undefined || p.kind === filter.kind) &&
        (filter?.visibility === undefined || p.visibility === filter.visibility);
      return chain(matches ? p : null);
    }),
    find: vi.fn(() => chain([])),
  };
  const media: any = { assertOwnedMedia: vi.fn().mockResolvedValue(undefined) };

  const service = new ConnectProfileService(
    profileModel,
    userModel,
    eventEmitter,
    allowances,
    reviews,
    connectionModel,
    companyPageModel,
    undefined, // storefrontModel (ADR-0004 erasure cascade; unused by this suite)
    media,
  );
  return { service, profileModel, userModel, companyPageModel };
}

/** A stored training subdoc shape (lean read). Defaults: linked to PAGE_ID,
 *  confirmed + opted-in (the happy path for BOTH alumni and placement). */
function trainingItem(over: Record<string, unknown> = {}) {
  return {
    id: new Types.ObjectId().toHexString(),
    instituteName: 'Surat Stitch Academy',
    companyPageId: PAGE_ID,
    course: 'Computerised Embroidery',
    confirmStatus: 'confirmed',
    shareWithInstitute: true,
    ...over,
  };
}

/** An experience subdoc shape (lean read). */
function expItem(over: Record<string, unknown> = {}) {
  return {
    workshop: 'Some Workshop',
    companyPageId: null,
    from: new Date('2025-01-01T00:00:00.000Z'),
    to: null,
    ...over,
  };
}

/** A profile row as the alumni/placement scan reads it (lean). */
function profileRow(over: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    visibility: 'public',
    openTo: { work: true },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    training: [trainingItem()],
    experience: [expItem()],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('ConnectProfileService.loadPublicInstitute (page gate)', () => {
  it('404s when the page does not exist', async () => {
    const f = build({ page: null });
    await expect(f.service.getInstituteAlumni(PAGE_ID.toHexString(), {})).rejects.toThrow(
      NotFoundException,
    );
    // No profile scan when the gate fails.
    expect(f.profileModel.find).not.toHaveBeenCalled();
  });

  it('404s when the page is a business (kind !== institute)', async () => {
    const f = build({ page: { _id: PAGE_ID, kind: 'business', visibility: 'public' } });
    await expect(f.service.getInstitutePlacements(PAGE_ID.toHexString(), {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s when the institute page is not public', async () => {
    const f = build({ page: { _id: PAGE_ID, kind: 'institute', visibility: 'hidden' } });
    await expect(f.service.getInstituteAlumni(PAGE_ID.toHexString(), {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s for an invalid pageId (never queries)', async () => {
    const f = build();
    await expect(f.service.getInstituteAlumni('not-a-hex', {})).rejects.toThrow(NotFoundException);
    expect(f.companyPageModel.findOne).not.toHaveBeenCalled();
  });
});

describe('ConnectProfileService.getInstituteAlumni', () => {
  it('returns ConnectPerson-shaped items (openStatus work) for opted-in public open-to-work alumni', async () => {
    const f = build();
    const studentId = new Types.ObjectId();
    // Scan returns one matching profile; getPeopleByIds then hydrates identity.
    f.profileModel.find = vi
      .fn()
      // 1st call: the alumni scan.
      .mockImplementationOnce(() => chain([profileRow({ userId: studentId })]))
      // 2nd call: the getPeopleByIds headline/openTo lookup.
      .mockImplementationOnce(() =>
        chain([{ userId: studentId, headline: 'Zari karigar', openTo: { work: true } }]),
      );
    f.userModel.find = vi.fn(() =>
      chain([{ _id: studentId, name: 'Anand Patel', profilePicture: 'https://img/a.jpg' }]),
    );

    const res = await f.service.getInstituteAlumni(PAGE_ID.toHexString(), { limit: 10 });

    expect(res.total).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      userId: studentId.toHexString(),
      name: 'Anand Patel',
      avatarUrl: 'https://img/a.jpg',
      headline: 'Zari karigar',
      openStatus: 'work',
    });
    // One batched people lookup (getPeopleByIds): userModel.find ran once.
    expect(f.userModel.find).toHaveBeenCalledTimes(1);
  });

  it('scopes the scan to THIS pageId + visibility public + openTo.work + shareWithInstitute (server-side)', async () => {
    const f = build();
    await f.service.getInstituteAlumni(PAGE_ID.toHexString(), {});
    // The scan filter must AND: visibility public, openTo.work true, and an
    // $elemMatch on training requiring companyPageId === pageId AND opted-in.
    const filter = f.profileModel.find.mock.calls[0][0];
    expect(filter.visibility).toBe('public');
    expect(filter['openTo.work']).toBe(true);
    expect(filter.training.$elemMatch).toMatchObject({
      companyPageId: expect.anything(),
      shareWithInstitute: true,
    });
    // Scoped to the given page (the $elemMatch companyPageId is THIS page).
    expect(String(filter.training.$elemMatch.companyPageId)).toBe(PAGE_ID.toHexString());
  });

  it('returns the explicit empty marker when no alumni match', async () => {
    const f = build();
    f.profileModel.find = vi.fn(() => chain([]));
    const res = await f.service.getInstituteAlumni(PAGE_ID.toHexString(), {});
    expect(res).toEqual({ items: [], total: 0, nextCursor: null });
    // No people hydration when nothing matched.
    expect(f.userModel.find).not.toHaveBeenCalled();
  });

  it('paginates: respects limit and returns a nextCursor when a full window over-fetches', async () => {
    const f = build();
    // limit 2 -> the scan over-fetches limit+1 = 3 rows; a 3rd row means hasMore.
    const ids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const rows = ids.map((id, i) =>
      profileRow({ _id: id, userId: id, createdAt: new Date(2026, 0, 3 - i) }),
    );
    f.profileModel.find = vi
      .fn()
      .mockImplementationOnce(() => chain(rows))
      .mockImplementationOnce(() =>
        chain(ids.slice(0, 2).map((id) => ({ userId: id, headline: 'k', openTo: { work: true } }))),
      );
    f.userModel.find = vi.fn(() =>
      chain(ids.slice(0, 2).map((id) => ({ _id: id, name: 'x', profilePicture: null }))),
    );

    const res = await f.service.getInstituteAlumni(PAGE_ID.toHexString(), { limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBeTypeOf('string');
    expect(res.nextCursor).not.toBeNull();
    // The scan asked for limit+1.
    const limitArg = f.profileModel.find.mock.results[0].value.limit.mock.calls[0][0];
    expect(limitArg).toBe(3);
  });
});

describe('ConnectProfileService.getInstitutePlacements', () => {
  it('derives the current employer from experience.to == null and groups/counts by employer', async () => {
    const f = build();
    const s1 = new Types.ObjectId();
    const s2 = new Types.ObjectId();
    const s3 = new Types.ObjectId();
    // s1 + s2 currently work at EMPLOYER_A (companyPageId); s3 at a free-text shop
    // (no companyPageId) -> the "other workplaces" bucket. Each has a PAST job
    // (to set) that must be ignored.
    f.profileModel.find = vi.fn(() =>
      chain([
        profileRow({
          userId: s1,
          experience: [
            expItem({ companyPageId: EMPLOYER_A, to: null, from: new Date('2025-06-01') }),
            expItem({ workshop: 'Old Shop', to: new Date('2024-01-01') }),
          ],
        }),
        profileRow({
          userId: s2,
          experience: [expItem({ companyPageId: EMPLOYER_A, to: null })],
        }),
        profileRow({
          userId: s3,
          experience: [expItem({ workshop: 'Galli Workshop', companyPageId: null, to: null })],
        }),
      ]),
    );
    // companyRefs resolve EMPLOYER_A (public).
    f.companyPageModel.find = vi.fn(() =>
      chain([
        {
          _id: EMPLOYER_A,
          name: 'Big Embroidery Co',
          slug: 'big-embroidery-co',
          logo: 'https://img/e.png',
          erpWorkspaceId: null,
        },
      ]),
    );

    const res = await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});

    expect(res.totalStudents).toBe(3);
    // One linked employer with 2 students.
    expect(res.employers).toHaveLength(1);
    expect(res.employers[0].studentCount).toBe(2);
    expect(res.employers[0].company).toMatchObject({
      id: EMPLOYER_A.toHexString(),
      name: 'Big Embroidery Co',
      slug: 'big-embroidery-co',
    });
    // The free-text employer rolls into otherEmployerCount.
    expect(res.otherEmployerCount).toBe(1);
  });

  it('picks the MOST RECENT current job (by from) when a student has several with to == null', async () => {
    const f = build();
    const s1 = new Types.ObjectId();
    f.profileModel.find = vi.fn(() =>
      chain([
        profileRow({
          userId: s1,
          experience: [
            expItem({ companyPageId: EMPLOYER_A, to: null, from: new Date('2024-01-01') }),
            expItem({ companyPageId: EMPLOYER_B, to: null, from: new Date('2026-01-01') }),
          ],
        }),
      ]),
    );
    f.companyPageModel.find = vi.fn(() =>
      chain([
        {
          _id: EMPLOYER_B,
          name: 'Newer Co',
          slug: 'newer-co',
          logo: '',
          erpWorkspaceId: null,
        },
      ]),
    );
    const res = await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    expect(res.totalStudents).toBe(1);
    expect(res.employers).toHaveLength(1);
    expect(res.employers[0].company.id).toBe(EMPLOYER_B.toHexString());
  });

  it('scopes the scan to confirmed + opted-in + public for THIS page only', async () => {
    const f = build();
    await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    const filter = f.profileModel.find.mock.calls[0][0];
    expect(filter.visibility).toBe('public');
    expect(filter.training.$elemMatch).toMatchObject({
      confirmStatus: 'confirmed',
      shareWithInstitute: true,
    });
    expect(String(filter.training.$elemMatch.companyPageId)).toBe(PAGE_ID.toHexString());
  });

  it('returns the explicit empty marker when no confirmed opted-in students', async () => {
    const f = build();
    f.profileModel.find = vi.fn(() => chain([]));
    const res = await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    expect(res).toEqual({ employers: [], otherEmployerCount: 0, totalStudents: 0 });
  });

  it('bounds the @Public scan with the LIST_HARD_CAP DoS backstop (no client limit)', async () => {
    // The placement scan is NOT keyset-paginated and grows with the institute's
    // confirmed-alumni count on an anonymous route, so it MUST cap the find().
    const f = build();
    await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    // The scan applied a .limit() and it equals the shared hard cap (500).
    const limitArg = f.profileModel.find.mock.results[0].value.limit.mock.calls[0][0];
    expect(limitArg).toBe(500);
  });

  it('honours a client limit as a REAL cap, clamped down to (never above) LIST_HARD_CAP', async () => {
    const f = build();
    // A small client limit lowers the scan cap below the hard ceiling.
    await f.service.getInstitutePlacements(PAGE_ID.toHexString(), { limit: 25 });
    expect(f.profileModel.find.mock.results[0].value.limit.mock.calls[0][0]).toBe(25);

    // An oversized client limit cannot raise the scan past the hard ceiling.
    const f2 = build();
    await f2.service.getInstitutePlacements(PAGE_ID.toHexString(), { limit: 100000 });
    expect(f2.profileModel.find.mock.results[0].value.limit.mock.calls[0][0]).toBe(500);
  });

  it('counts a student with NO current job (every experience has a to) toward totalStudents but no employer', async () => {
    const f = build();
    const s1 = new Types.ObjectId();
    f.profileModel.find = vi.fn(() =>
      chain([
        profileRow({
          userId: s1,
          experience: [expItem({ to: new Date('2024-01-01') })],
        }),
      ]),
    );
    const res = await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    expect(res.totalStudents).toBe(1);
    expect(res.employers).toEqual([]);
    expect(res.otherEmployerCount).toBe(0);
  });
});

describe('ConnectProfileService Feature 3 DPDP / scoping invariants (filter-driven)', () => {
  // The scan is the chokepoint: a hidden/connections profile, a not-opted-in
  // credential, and an other-page credential are all excluded by the Mongo
  // filter (visibility + $elemMatch). These tests assert the filter is correct
  // so those rows can never reach the result, independent of any in-memory pass.

  it('alumni filter never matches a non-public profile (visibility pinned to public)', async () => {
    const f = build();
    await f.service.getInstituteAlumni(PAGE_ID.toHexString(), {});
    const filter = f.profileModel.find.mock.calls[0][0];
    // A hidden/connections profile cannot satisfy visibility === 'public'.
    expect(filter.visibility).toBe('public');
  });

  it('alumni filter never matches a not-opted-in credential (shareWithInstitute pinned true)', async () => {
    const f = build();
    await f.service.getInstituteAlumni(PAGE_ID.toHexString(), {});
    const filter = f.profileModel.find.mock.calls[0][0];
    expect(filter.training.$elemMatch.shareWithInstitute).toBe(true);
  });

  it('placement filter never matches an other-institute credential (companyPageId pinned to this page)', async () => {
    const f = build();
    await f.service.getInstitutePlacements(PAGE_ID.toHexString(), {});
    const filter = f.profileModel.find.mock.calls[0][0];
    expect(String(filter.training.$elemMatch.companyPageId)).toBe(PAGE_ID.toHexString());
    expect(String(filter.training.$elemMatch.companyPageId)).not.toBe(OTHER_PAGE_ID.toHexString());
  });

  it('alumni in-memory guard also drops a row whose matching credential is for another page only', async () => {
    // Defence in depth: even if a row reached the post-scan pass with ONLY an
    // other-page opted-in credential (e.g. a different opted-in credential made
    // the doc-level $elemMatch pass), it must not be counted under THIS page.
    // We feed the scan a row whose ONLY opted-in credential links OTHER_PAGE_ID;
    // the per-row re-check must exclude it.
    const f = build();
    const studentId = new Types.ObjectId();
    f.profileModel.find = vi
      .fn()
      .mockImplementationOnce(() =>
        chain([
          profileRow({
            userId: studentId,
            training: [
              trainingItem({ companyPageId: OTHER_PAGE_ID, shareWithInstitute: true }),
              trainingItem({ companyPageId: PAGE_ID, shareWithInstitute: false }),
            ],
          }),
        ]),
      )
      .mockImplementationOnce(() => chain([]));
    const res = await f.service.getInstituteAlumni(PAGE_ID.toHexString(), {});
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
  });
});
