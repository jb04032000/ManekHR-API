/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (ConnectProfile / CompanyPage / User) skip vitest's reflect-metadata
// pipeline. Mirrors the canonical inquiry.service.vitest.ts pure-unit pattern.
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
 * Unit coverage for the Institutes Phase 2 Feature 2 institute-admin write path
 * (`listPendingCredentialRequests` + `decideCredential`) added to
 * `ConnectProfileService`. These are the ONLY methods that may set a training
 * credential's `confirmStatus` to `confirmed` / `declined`. Verifies:
 *   - confirm flips a pending entry to `confirmed` + stamps confirmedAt /
 *     confirmedByUserId;
 *   - decline sets `declined` + clears that metadata;
 *   - a non-owner caller is rejected (CompanyPageService.getMine throws 404);
 *   - a trainingId whose companyPageId != the admin's pageId 404s (no
 *     cross-institute write);
 *   - list-pending returns only `pending` entries linking THIS page (self
 *     entries are excluded), batched (no N+1);
 *   - a confirmed entry still resolves its institute company link.
 * Models + the CompanyPageService gate + the audit / posthog / notifications
 * seams are all mocked.
 */

const PAGE_OWNER = new Types.ObjectId();
const PAGE_ID = new Types.ObjectId();
const OTHER_PAGE_ID = new Types.ObjectId();
const STUDENT = new Types.ObjectId();
const TRAINING_ID = new Types.ObjectId().toHexString();

/** Fluent query chain whose terminal `.exec()` resolves `result`. */
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

/**
 * Build a ConnectProfileService with a positional-constructor of stubs. Only the
 * deps the Feature 2 path touches are functional: profileModel (find +
 * findOne+save), userModel (batch find), companyPageModel (companyRefs),
 * companyPages gate (getMine), audit, posthog, notifications. The rest are
 * harmless stubs. `eventEmitter` is a no-op emit so `getOrCreateForUser`'s
 * change-signal does not throw.
 */
function build(opts?: { getMineThrows?: boolean }) {
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
  const companyPageModel: any = { find: vi.fn(() => chain([])) };
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

  // The page-admin gate + the institute-side seams are injected by the new
  // setter (so the leaf institutes module wires them without a constructor
  // change that would break every positional unit test).
  const companyPages: any = {
    getMine: vi.fn(async (ownerId: string, pageId: string) => {
      if (opts?.getMineThrows) throw new NotFoundException('Company page not found');
      return { _id: new Types.ObjectId(pageId), ownerUserId: new Types.ObjectId(ownerId) };
    }),
  };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const posthog: any = { capture: vi.fn() };
  const notifications: any = { dispatch: vi.fn().mockResolvedValue(undefined) };
  service.setInstituteDeps({ companyPages, audit, posthog, notifications });

  return {
    service,
    profileModel,
    userModel,
    companyPageModel,
    companyPages,
    audit,
    posthog,
    notifications,
  };
}

/** A stored training subdoc shape (lean read). */
function trainingItem(over: Record<string, unknown> = {}) {
  return {
    id: TRAINING_ID,
    instituteName: 'Surat Stitch Academy',
    companyPageId: PAGE_ID,
    course: 'Computerised Embroidery',
    completedAt: new Date('2026-05-01T00:00:00.000Z'),
    confirmStatus: 'pending',
    confirmedAt: null,
    confirmedByUserId: null,
    shareWithInstitute: false,
    ...over,
  };
}

/** A live Mongoose-doc stub the decide path load-modify-saves. */
function profileDoc(training: any[]) {
  return {
    _id: new Types.ObjectId(),
    userId: STUDENT,
    training,
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('ConnectProfileService.listPendingCredentialRequests', () => {
  it('returns only pending entries linking THIS page, with batched student identity (no N+1)', async () => {
    const f = build();
    // Two students, each with a pending credential on PAGE_ID; one also carries a
    // self entry (must NOT appear) and a pending entry on ANOTHER page (must NOT appear).
    const studentA = STUDENT;
    const studentB = new Types.ObjectId();
    const trainIdA = TRAINING_ID;
    const trainIdB = new Types.ObjectId().toHexString();
    f.profileModel.find = vi.fn(() =>
      chain([
        {
          userId: studentA,
          training: [
            trainingItem({ id: trainIdA }),
            trainingItem({
              id: new Types.ObjectId().toHexString(),
              confirmStatus: 'self',
              companyPageId: PAGE_ID,
            }),
            trainingItem({
              id: new Types.ObjectId().toHexString(),
              confirmStatus: 'pending',
              companyPageId: OTHER_PAGE_ID,
            }),
          ],
        },
        {
          userId: studentB,
          training: [trainingItem({ id: trainIdB, instituteName: 'Other Academy' })],
        },
      ]),
    );
    f.userModel.find = vi.fn(() =>
      chain([
        {
          _id: studentA,
          name: 'Anand Patel',
          profilePicture: 'https://img/a.jpg',
          handle: 'anand',
        },
        { _id: studentB, name: 'Meera Shah', profilePicture: null, handle: 'meera' },
      ]),
    );

    const rows = await f.service.listPendingCredentialRequests(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
    );

    // Gate ran with the caller + page.
    expect(f.companyPages.getMine).toHaveBeenCalledWith(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
    );
    // One batched user lookup (no N+1).
    expect(f.userModel.find).toHaveBeenCalledTimes(1);
    // Two matching credentials total (one per student); the self entry + the
    // other-page entry are excluded.
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.student.userId === studentA.toHexString());
    expect(a).toBeDefined();
    expect(a.student).toMatchObject({
      userId: studentA.toHexString(),
      name: 'Anand Patel',
      avatar: 'https://img/a.jpg',
      handle: 'anand',
    });
    expect(a.training).toMatchObject({
      id: trainIdA,
      course: 'Computerised Embroidery',
      instituteName: 'Surat Stitch Academy',
    });
    // Never leaks the institute-internal confirmedByUserId pointer.
    expect((a.training as any).confirmedByUserId).toBeUndefined();
  });

  it('rejects a non-owner caller (getMine 404 propagates, no profile query runs)', async () => {
    const f = build({ getMineThrows: true });
    await expect(
      f.service.listPendingCredentialRequests(PAGE_OWNER.toHexString(), PAGE_ID.toHexString()),
    ).rejects.toThrow(NotFoundException);
    expect(f.profileModel.find).not.toHaveBeenCalled();
  });

  it('returns [] when no profile has a pending credential for this page', async () => {
    const f = build();
    f.profileModel.find = vi.fn(() => chain([]));
    const rows = await f.service.listPendingCredentialRequests(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
    );
    expect(rows).toEqual([]);
    // No people batch when there is nothing to hydrate.
    expect(f.userModel.find).not.toHaveBeenCalled();
  });
});

describe('ConnectProfileService.decideCredential', () => {
  it('confirm flips the matching entry to confirmed + stamps confirmedAt + confirmedByUserId', async () => {
    const f = build();
    const doc = profileDoc([trainingItem()]);
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));

    const before = Date.now();
    await f.service.decideCredential(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
      STUDENT.toHexString(),
      TRAINING_ID,
      'confirm',
    );

    const item = doc.training[0];
    expect(item.confirmStatus).toBe('confirmed');
    expect(item.confirmedByUserId).toBeInstanceOf(Types.ObjectId);
    expect(String(item.confirmedByUserId)).toBe(PAGE_OWNER.toHexString());
    expect(item.confirmedAt).toBeInstanceOf(Date);
    expect((item.confirmedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.save).toHaveBeenCalledOnce();

    // Audit + posthog fired with the confirm action.
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'ConnectTrainingCredential',
        entityId: TRAINING_ID,
        action: 'connect_credential_confirmed',
        actorId: PAGE_OWNER.toHexString(),
      }),
    );
    expect(f.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'connect.credential_confirmed',
        distinctId: PAGE_OWNER.toHexString(),
      }),
    );
    // Best-effort student notification.
    expect(f.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'connect.credential_confirmed',
        recipientId: STUDENT,
      }),
    );
  });

  it('decline sets declined + clears confirmedAt + confirmedByUserId', async () => {
    const f = build();
    // Start from an already-confirmed entry to prove decline CLEARS the metadata.
    const doc = profileDoc([
      trainingItem({
        confirmStatus: 'confirmed',
        confirmedAt: new Date('2026-06-01T00:00:00.000Z'),
        confirmedByUserId: PAGE_OWNER,
      }),
    ]);
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));

    await f.service.decideCredential(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
      STUDENT.toHexString(),
      TRAINING_ID,
      'decline',
    );

    const item = doc.training[0];
    expect(item.confirmStatus).toBe('declined');
    expect(item.confirmedAt).toBeNull();
    expect(item.confirmedByUserId).toBeNull();
    expect(doc.save).toHaveBeenCalledOnce();
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'connect_credential_declined', entityId: TRAINING_ID }),
    );
    expect(f.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.credential_declined' }),
    );
  });

  it('rejects a non-owner caller (getMine 404, no profile load / write)', async () => {
    const f = build({ getMineThrows: true });
    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        TRAINING_ID,
        'confirm',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(f.profileModel.findOne).not.toHaveBeenCalled();
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });

  it('404s when the trainingId links a DIFFERENT page (cross-institute write blocked)', async () => {
    const f = build();
    // The student's credential exists but its companyPageId is OTHER_PAGE_ID, not
    // the admin's PAGE_ID, so the admin may not touch it.
    const doc = profileDoc([trainingItem({ companyPageId: OTHER_PAGE_ID })]);
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));

    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        TRAINING_ID,
        'confirm',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(doc.save).not.toHaveBeenCalled();
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });

  it('404s when the trainingId is unknown on the student profile', async () => {
    const f = build();
    const doc = profileDoc([trainingItem({ id: new Types.ObjectId().toHexString() })]);
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        TRAINING_ID,
        'confirm',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the student profile does not exist', async () => {
    const f = build();
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        TRAINING_ID,
        'confirm',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('still resolves when the best-effort student notification rejects', async () => {
    const f = build();
    const doc = profileDoc([trainingItem()]);
    f.profileModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) }));
    f.notifications.dispatch = vi.fn().mockRejectedValue(new Error('bell down'));
    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        TRAINING_ID,
        'confirm',
      ),
    ).resolves.toBeTruthy();
    expect(doc.training[0].confirmStatus).toBe('confirmed');
  });

  it('404s when the trainingId is not a valid ObjectId hex (never queries)', async () => {
    const f = build();
    await expect(
      f.service.decideCredential(
        PAGE_OWNER.toHexString(),
        PAGE_ID.toHexString(),
        STUDENT.toHexString(),
        'not-a-hex',
        'confirm',
      ),
    ).rejects.toThrow(NotFoundException);
    // The gate still ran (page ownership checked first), but no profile load.
    expect(f.profileModel.findOne).not.toHaveBeenCalled();
  });
});

describe('ConnectProfileService Feature 2: confirmed entry still resolves its institute link', () => {
  it('list-pending hydrates the linked company ref for a (re-listed) pending entry', async () => {
    // The list path resolves each row's companyPageId to a public ref via the
    // CompanyPage model (same batched lookup pattern as the profile read). A
    // confirmed/pending entry on a public page resolves; a hidden page drops.
    const f = build();
    f.profileModel.find = vi.fn(() => chain([{ userId: STUDENT, training: [trainingItem()] }]));
    f.userModel.find = vi.fn(() =>
      chain([{ _id: STUDENT, name: 'Anand', profilePicture: null, handle: 'anand' }]),
    );
    f.companyPageModel.find = vi.fn(() =>
      chain([
        {
          _id: PAGE_ID,
          name: 'Surat Stitch Academy',
          slug: 'surat-stitch-academy',
          logo: 'https://img/logo.png',
          erpWorkspaceId: null,
        },
      ]),
    );

    const rows = await f.service.listPendingCredentialRequests(
      PAGE_OWNER.toHexString(),
      PAGE_ID.toHexString(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toMatchObject({
      id: PAGE_ID.toHexString(),
      name: 'Surat Stitch Academy',
      slug: 'surat-stitch-academy',
      logo: 'https://img/logo.png',
      erpLinked: false,
    });
  });
});
