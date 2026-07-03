/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// The service now imports TagService (custom category/role normalization), whose
// transitive chain reaches src/config/env.ts -> `dotenv/config`. Stub it so the
// unit test loads without a real env file (matches the repo's cron unit tests).
vi.mock('dotenv/config', () => ({}));

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports skip vitest's reflect-metadata pipeline.
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
import { JobsService } from '../jobs.service';

const COMPANY = new Types.ObjectId();
const KARIGAR = new Types.ObjectId();
const JOB = new Types.ObjectId();
const PAGE = new Types.ObjectId();

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

const openJob = { _id: JOB, companyUserId: COMPANY, status: 'open', title: 'Zari operator' };

function build() {
  const jobModel: any = {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ _id: JOB }),
    find: vi.fn(() => chain([])),
    findById: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({}),
  };
  const applicationModel: any = {
    findOne: vi.fn(() => null),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    find: vi.fn(() => chain([])),
    findById: vi.fn(),
  };
  // Per-(job, viewer) view dedup model (getJob) + the candidate's private
  // bookmarks model (saveJob/unsaveJob/listSavedJobs). Not exercised by these
  // specs, but the JobsService constructor injects them positionally.
  const jobViewModel: any = {
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
  };
  const savedJobModel: any = {
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    deleteOne: vi.fn().mockResolvedValue({}),
    find: vi.fn(() => chain([])),
  };
  const userModel: any = { findById: vi.fn(() => chain({ name: 'Anand Patel' })) };
  const allowances: any = { assertCanCreateJob: vi.fn().mockResolvedValue(undefined) };
  const companyPages: any = { getMine: vi.fn().mockResolvedValue({ _id: PAGE }) };
  const notifications: any = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter: any = { emit: vi.fn() };
  // TagService folds category/role into the shared pool. Default: no known slug
  // (returns []), so the service falls back to trim+lowercase of the raw term.
  const tagService: any = {
    normalizeHashtags: vi.fn().mockResolvedValue([]),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };
  const posthog: any = { capture: vi.fn() };
  // Shared media-ownership guard. assertOwnedMedia passes by default (any URL);
  // getServerVideoDurationByUrl returns a 45s server-parsed duration (within the
  // 60s upload-probe cap) so the video paths stamp durationSec. Mirrors the
  // listing.service spec's media mock.
  const media: any = {
    assertOwnedMedia: vi.fn(() => Promise.resolve()),
    getServerVideoDurationByUrl: vi.fn().mockResolvedValue(45),
  };
  // Positional order must mirror the JobsService constructor exactly:
  // jobModel, applicationModel, jobViewModel, savedJobModel, userModel,
  // allowances, companyPages, notifications, audit, eventEmitter, tagService,
  // posthog, jobBoosts, media. jobBoosts (@Optional, promoted-jobs resolver) is
  // unused here so it is passed undefined; media is the shared media-ownership
  // guard the apply path now calls (stubbed to allow any URL).
  const service = new JobsService(
    jobModel,
    applicationModel,
    jobViewModel,
    savedJobModel,
    userModel,
    allowances,
    companyPages,
    notifications,
    audit,
    eventEmitter,
    tagService,
    posthog,
    undefined,
    media,
  );
  return {
    service,
    jobModel,
    applicationModel,
    jobViewModel,
    savedJobModel,
    userModel,
    allowances,
    companyPages,
    notifications,
    audit,
    tagService,
    posthog,
    media,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('JobsService.createJob', () => {
  it('asserts the open-job cap and stamps a page when posting AS a company page', async () => {
    const f = build();
    f.jobModel.countDocuments = vi.fn().mockResolvedValue(3);

    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Zari operator',
      category: 'embroidery-zari',
      companyPageId: PAGE.toHexString(),
    } as any);

    expect(f.allowances.assertCanCreateJob).toHaveBeenCalledWith(COMPANY.toHexString(), 3);
    expect(f.companyPages.getMine).toHaveBeenCalledWith(COMPANY.toHexString(), PAGE.toHexString());
    const arg = f.jobModel.create.mock.calls[0][0];
    expect(String(arg.companyPageId)).toBe(String(PAGE));
    expect(arg.status).toBe('open');
  });

  it('creates a personal job (no page) with companyPageId null', async () => {
    const f = build();
    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Helper',
      category: 'job-work',
    } as any);
    expect(f.companyPages.getMine).not.toHaveBeenCalled();
    expect(f.jobModel.create.mock.calls[0][0].companyPageId).toBeNull();
  });

  it('normalizes a custom category + role through the shared tag pool and records usage', async () => {
    const f = build();
    // The tag engine folds each raw term to its canonical slug.
    f.tagService.normalizeHashtags = vi
      .fn()
      .mockResolvedValueOnce(['tie-dye'])
      .mockResolvedValueOnce(['master-craftsman']);

    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Bandhani specialist',
      category: 'Tie Dye',
      role: 'Master Craftsman',
    } as any);

    const arg = f.jobModel.create.mock.calls[0][0];
    expect(arg.category).toBe('tie-dye');
    expect(arg.role).toBe('master-craftsman');
    // Both canonical slugs are recorded for popularity ranking.
    expect(f.tagService.recordUsage).toHaveBeenCalledWith(
      ['tie-dye', 'master-craftsman'],
      COMPANY.toHexString(),
    );
  });

  it('falls back to trim+lowercase when the tag engine returns no slug', async () => {
    const f = build();
    // Default mock returns [] -> the raw term is trimmed + lowercased.
    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Weaver',
      category: '  Handloom  ',
    } as any);
    const arg = f.jobModel.create.mock.calls[0][0];
    expect(arg.category).toBe('handloom');
    expect(arg.role).toBeNull();
  });

  // ── Job video (first media field on jobs; mirrors the listing video suite) ──

  it('persists an owned job video and stamps the SERVER-derived durationSec', async () => {
    const f = build();
    // The owned upload record probed this clip at 45s (within the 60s cap).
    f.media.getServerVideoDurationByUrl.mockResolvedValue(45);

    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Zari operator',
      category: 'embroidery-zari',
      videos: [{ url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg' }],
    } as any);

    // url + posterUrl both ownership-checked (flattened into one guard call).
    const ownArg = f.media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/clip.mp4'),
    );
    expect(ownArg?.[0]).toEqual(
      expect.arrayContaining(['https://cdn/clip.mp4', 'https://cdn/poster.jpg']),
    );
    const arg = f.jobModel.create.mock.calls[0][0];
    expect(arg.videos).toEqual([
      { url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg', durationSec: 45 },
    ]);
  });

  it('rejects a video URL the caller does not own (media-ownership guard throws), no persist', async () => {
    const f = build();
    f.media.assertOwnedMedia.mockRejectedValue(new BadRequestException('not yours'));

    await expect(
      f.service.createJob(COMPANY.toHexString(), {
        title: 'Zari operator',
        category: 'embroidery-zari',
        videos: [{ url: 'https://cdn/foreign.mp4' }],
      } as any),
    ).rejects.toThrow();
    expect(f.jobModel.create).not.toHaveBeenCalled();
  });

  // NOTE: a 90s (over-length) clip is NOT rejected by this service. The 60s cap
  // lives in the upload media-probe (uploads `connect-job-video` policy), exactly
  // like the listing surface; durationSec here is simply whatever the owned upload
  // record reports. This test pins that contract: an over-cap duration is stamped
  // as-is (it could never get a server duration without first passing the probe).
  it('does not enforce the 60s cap in the service (cap is in the upload media-probe)', async () => {
    const f = build();
    f.media.getServerVideoDurationByUrl.mockResolvedValue(90);

    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Zari operator',
      category: 'embroidery-zari',
      videos: [{ url: 'https://cdn/long.mp4' }],
    } as any);

    const arg = f.jobModel.create.mock.calls[0][0];
    expect(arg.videos).toEqual([{ url: 'https://cdn/long.mp4', durationSec: 90 }]);
  });

  it('leaves videos empty (unchanged behavior) when none are submitted', async () => {
    const f = build();

    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Helper',
      category: 'job-work',
    } as any);

    const arg = f.jobModel.create.mock.calls[0][0];
    expect(arg.videos).toEqual([]);
    expect(f.media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });
});

describe('JobsService.updateJob', () => {
  // A savable, owned, open job document (loadOwnedJob returns a Mongoose doc).
  const ownedOpenJob = (overrides: Record<string, unknown> = {}) => ({
    _id: JOB,
    companyUserId: COMPANY,
    status: 'open',
    title: 'Old title',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  it('edits only the provided fields on an open owned job, saves + audits', async () => {
    const f = build();
    const job = ownedOpenJob();
    f.jobModel.findById = vi.fn().mockResolvedValue(job);

    await f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), {
      title: 'New title',
      openings: 3,
    } as any);

    expect(job.title).toBe('New title');
    expect((job as any).openings).toBe(3);
    expect(job.save).toHaveBeenCalledTimes(1);
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job_updated' }),
    );
  });

  it('rejects a non-owner (NotFound, no existence leak)', async () => {
    const f = build();
    f.jobModel.findById = vi
      .fn()
      .mockResolvedValue(ownedOpenJob({ companyUserId: new Types.ObjectId() }));
    await expect(
      f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), { title: 'x' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects editing a job that is not open', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue(ownedOpenJob({ status: 'closed' }));
    await expect(
      f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), { title: 'x' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizes an edited custom category through the tag pool + records usage', async () => {
    const f = build();
    const job = ownedOpenJob();
    f.jobModel.findById = vi.fn().mockResolvedValue(job);
    f.tagService.normalizeHashtags = vi.fn().mockResolvedValueOnce(['tie-dye']);

    await f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), {
      category: 'Tie Dye',
    } as any);

    expect((job as any).category).toBe('tie-dye');
    expect(f.tagService.recordUsage).toHaveBeenCalledWith(['tie-dye'], COMPANY.toHexString());
  });

  it('keeps the existing video (grandfathered) on edit + re-stamps the server duration', async () => {
    const f = build();
    const existingVideo = { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg' };
    const job = ownedOpenJob({ videos: [existingVideo] });
    f.jobModel.findById = vi.fn().mockResolvedValue(job);
    f.media.getServerVideoDurationByUrl.mockResolvedValue(30);

    await f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), {
      videos: [existingVideo],
    } as any);

    // Video guard grandfathers the existing clip url + poster (no NEW ownership
    // record required to keep it); the duration is re-stamped server-side.
    const vidCall = f.media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/old.mp4'),
    );
    expect(vidCall?.[1]).toBe(COMPANY.toHexString());
    expect(vidCall?.[2]?.grandfatheredUrls).toEqual(
      expect.arrayContaining(['https://cdn/old.mp4', 'https://cdn/oldposter.jpg']),
    );
    expect((job as any).videos).toEqual([
      { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg', durationSec: 30 },
    ]);
    expect(job.save).toHaveBeenCalledTimes(1);
  });

  it('leaves the existing video untouched when videos is omitted from the patch', async () => {
    const f = build();
    const job = ownedOpenJob({ videos: [{ url: 'https://cdn/keep.mp4', durationSec: 20 }] });
    f.jobModel.findById = vi.fn().mockResolvedValue(job);

    await f.service.updateJob(COMPANY.toHexString(), JOB.toHexString(), {
      title: 'just a title change',
    } as any);

    expect((job as any).videos).toEqual([{ url: 'https://cdn/keep.mp4', durationSec: 20 }]);
    expect(f.media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });
});

describe('JobsService.closeJob (hire outcome)', () => {
  const ownedOpenJob = () => ({
    _id: JOB,
    companyUserId: COMPANY,
    status: 'open',
    save: vi.fn().mockResolvedValue(undefined),
  });

  it('marks the job filled + audits job_filled when filled=true', async () => {
    const f = build();
    const job = ownedOpenJob();
    f.jobModel.findById = vi.fn().mockResolvedValue(job);

    await f.service.closeJob(COMPANY.toHexString(), JOB.toHexString(), true);

    expect(job.status).toBe('filled');
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job_filled' }),
    );
  });

  it('closes the job (default) + audits job_closed when filled omitted', async () => {
    const f = build();
    const job = ownedOpenJob();
    f.jobModel.findById = vi.fn().mockResolvedValue(job);

    await f.service.closeJob(COMPANY.toHexString(), JOB.toHexString());

    expect(job.status).toBe('closed');
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job_closed' }),
    );
  });
});

describe('JobsService.listByCompanyPageForOwner', () => {
  it('asserts page ownership (getMine) then returns all statuses newest-first', async () => {
    const f = build();
    const all = [
      { _id: JOB, status: 'open' },
      { _id: new Types.ObjectId(), status: 'closed' },
      { _id: new Types.ObjectId(), status: 'filled' },
    ];
    f.jobModel.find = vi.fn(() => chain(all));

    const res = await f.service.listByCompanyPageForOwner(
      COMPANY.toHexString(),
      PAGE.toHexString(),
    );

    expect(f.companyPages.getMine).toHaveBeenCalledWith(COMPANY.toHexString(), PAGE.toHexString());
    // The find filter is page-scoped with NO status filter (history = all statuses).
    const filter = f.jobModel.find.mock.calls[0][0];
    expect(String(filter.companyPageId)).toBe(String(PAGE));
    expect(filter.status).toBeUndefined();
    expect(res).toHaveLength(3);
  });

  it('propagates getMine 404 for a page the caller does not own', async () => {
    const f = build();
    f.companyPages.getMine = vi
      .fn()
      .mockRejectedValue(new NotFoundException('Company page not found'));
    await expect(
      f.service.listByCompanyPageForOwner(COMPANY.toHexString(), PAGE.toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('JobsService.applyToJob', () => {
  it('blocks applying to your own job', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue(openJob);
    await expect(
      f.service.applyToJob(COMPANY.toHexString(), JOB.toHexString(), {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks applying to a closed job', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue({ ...openJob, status: 'closed' });
    await expect(
      f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a new application, bumps the count, and notifies the company', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue(openJob);
    f.applicationModel.findOne = vi.fn().mockResolvedValue(null);

    await f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), { message: 'Hi' });

    expect(f.applicationModel.create).toHaveBeenCalledTimes(1);
    expect(f.jobModel.updateOne).toHaveBeenCalledWith(
      { _id: JOB },
      { $inc: { applicationsCount: 1 } },
    );
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
    const n = f.notifications.dispatch.mock.calls[0][0];
    expect(n.category).toBe('connect.job_application_received');
    expect(String(n.recipientId)).toBe(String(COMPANY));
    expect(n.message).toContain('Anand Patel');
    expect(n.message).toContain('Zari operator');
  });

  it('a repeat application edits in place and stays quiet (no count bump, no notify)', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue(openJob);
    const existing: any = { _id: new Types.ObjectId(), status: 'applied' };
    existing.save = vi.fn().mockResolvedValue(existing);
    f.applicationModel.findOne = vi.fn().mockResolvedValue(existing);

    await f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), {
      message: 'Updated',
    });

    expect(existing.save).toHaveBeenCalled();
    expect(f.applicationModel.create).not.toHaveBeenCalled();
    expect(f.jobModel.updateOne).not.toHaveBeenCalled();
    expect(f.notifications.dispatch).not.toHaveBeenCalled();
  });
});

describe('JobsService demo content (Demo Content scope)', () => {
  // Make userModel.findById return a chosen demo flag for resolveIsDemo, while
  // still carrying `name` for the new-application notification path.
  const userAs = (isDemo: boolean, email?: string) =>
    vi.fn(() => chain({ name: 'Anand Patel', isDemo, email }));

  it('createJob stamps isDemo from the owner (real owner -> false)', async () => {
    const f = build();
    f.userModel.findById = userAs(false);
    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Helper',
      category: 'job-work',
    } as any);
    expect(f.jobModel.create.mock.calls[0][0].isDemo).toBe(false);
  });

  it('createJob stamps isDemo=true for a seeded demo owner', async () => {
    const f = build();
    f.userModel.findById = userAs(true);
    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Helper',
      category: 'job-work',
    } as any);
    expect(f.jobModel.create.mock.calls[0][0].isDemo).toBe(true);
  });

  it('createJob treats a @connect-demo.zari360.test owner as demo even if isDemo unset', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() =>
      chain({ name: 'Seed', email: 'karigar1@connect-demo.zari360.test' }),
    );
    await f.service.createJob(COMPANY.toHexString(), {
      title: 'Helper',
      category: 'job-work',
    } as any);
    expect(f.jobModel.create.mock.calls[0][0].isDemo).toBe(true);
  });

  it('blocks a real worker applying to a sample (demo) job and does not notify/bump', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue({ ...openJob, isDemo: true });
    f.userModel.findById = userAs(false); // real applicant
    await expect(
      f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.applicationModel.create).not.toHaveBeenCalled();
    expect(f.jobModel.updateOne).not.toHaveBeenCalled();
    expect(f.notifications.dispatch).not.toHaveBeenCalled();
  });

  it('blocks a demo worker applying to a real job', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue({ ...openJob, isDemo: false });
    f.userModel.findById = userAs(true); // demo applicant
    await expect(
      f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.applicationModel.create).not.toHaveBeenCalled();
  });

  it('allows a demo<->demo application but skips the real count bump + notification', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue({ ...openJob, isDemo: true });
    f.applicationModel.findOne = vi.fn().mockResolvedValue(null);
    f.userModel.findById = userAs(true); // demo applicant

    await f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), { message: 'Hi' });

    // The application IS created (and stamped isDemo)...
    expect(f.applicationModel.create).toHaveBeenCalledTimes(1);
    expect(f.applicationModel.create.mock.calls[0][0].isDemo).toBe(true);
    // ...but the real applicantsCount stat + the real notification are skipped.
    expect(f.jobModel.updateOne).not.toHaveBeenCalled();
    expect(f.notifications.dispatch).not.toHaveBeenCalled();
  });

  it('stamps isDemo=false on a real-to-real application and keeps count + notify', async () => {
    const f = build();
    f.jobModel.findById = vi.fn().mockResolvedValue({ ...openJob, isDemo: false });
    f.applicationModel.findOne = vi.fn().mockResolvedValue(null);
    f.userModel.findById = userAs(false); // real applicant

    await f.service.applyToJob(KARIGAR.toHexString(), JOB.toHexString(), { message: 'Hi' });

    expect(f.applicationModel.create.mock.calls[0][0].isDemo).toBe(false);
    expect(f.jobModel.updateOne).toHaveBeenCalledWith(
      { _id: JOB },
      { $inc: { applicationsCount: 1 } },
    );
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('JobsService application review', () => {
  it('acceptApplication marks accepted, fills the job, and notifies the applicant', async () => {
    const f = build();
    const application: any = {
      _id: new Types.ObjectId(),
      jobId: JOB,
      applicantUserId: KARIGAR,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.applicationModel.findById = vi.fn().mockResolvedValue(application);
    f.jobModel.findById = vi
      .fn()
      .mockResolvedValueOnce(openJob) // loadOwnedJob (ownership check)
      .mockReturnValueOnce(chain({ title: 'Zari operator' })); // notifyApplicant title lookup

    await f.service.acceptApplication(COMPANY.toHexString(), String(application._id));

    expect(application.status).toBe('accepted');
    expect(f.jobModel.updateOne).toHaveBeenCalledWith({ _id: JOB }, { $set: { status: 'filled' } });
    const n = f.notifications.dispatch.mock.calls[0][0];
    expect(n.category).toBe('connect.job_application_accepted');
    expect(String(n.recipientId)).toBe(String(KARIGAR));
  });

  it('acceptApplication 404s when the caller does not own the job', async () => {
    const f = build();
    const application: any = { _id: new Types.ObjectId(), jobId: JOB, applicantUserId: KARIGAR };
    f.applicationModel.findById = vi.fn().mockResolvedValue(application);
    // loadOwnedJob: job owned by someone else.
    f.jobModel.findById = vi
      .fn()
      .mockResolvedValue({ ...openJob, companyUserId: new Types.ObjectId() });
    await expect(
      f.service.acceptApplication(COMPANY.toHexString(), String(application._id)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('withdrawApplication 404s on an application the caller does not own', async () => {
    const f = build();
    f.applicationModel.findById = vi
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId(), applicantUserId: new Types.ObjectId() });
    await expect(
      f.service.withdrawApplication(KARIGAR.toHexString(), new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('JobsService analytics events', () => {
  /** PostHog event name fired by the given capture call (for assertions). */
  const eventOf = (f: ReturnType<typeof build>) =>
    f.posthog.capture.mock.calls.map((c: any[]) => c[0].event);

  it('closeJob fires connect.job_closed for the owner', async () => {
    const f = build();
    const job: any = { _id: JOB, companyUserId: COMPANY, status: 'open', save: vi.fn() };
    f.jobModel.findById = vi.fn().mockResolvedValue(job);

    await f.service.closeJob(COMPANY.toHexString(), JOB.toHexString());

    const call = f.posthog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'connect.job_closed',
    );
    expect(call).toBeDefined();
    expect(call[0].distinctId).toBe(COMPANY.toHexString());
    expect(call[0].properties.jobId).toBe(JOB.toHexString());
  });

  it('setApplicationStatus fires the shortlisted / declined event', async () => {
    const application: any = {
      _id: new Types.ObjectId(),
      jobId: JOB,
      applicantUserId: KARIGAR,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const shortlist = build();
    shortlist.applicationModel.findById = vi.fn().mockResolvedValue(application);
    shortlist.jobModel.findById = vi.fn().mockResolvedValue(openJob);
    await shortlist.service.setApplicationStatus(
      COMPANY.toHexString(),
      String(application._id),
      'shortlisted',
    );
    expect(eventOf(shortlist)).toContain('connect.job_application_shortlisted');

    const decline = build();
    application.save = vi.fn().mockResolvedValue(undefined);
    decline.applicationModel.findById = vi.fn().mockResolvedValue(application);
    decline.jobModel.findById = vi
      .fn()
      .mockResolvedValueOnce(openJob) // loadOwnedJob
      .mockReturnValueOnce(chain({ title: 'Zari operator' })); // notifyApplicant title lookup
    await decline.service.setApplicationStatus(
      COMPANY.toHexString(),
      String(application._id),
      'declined',
    );
    expect(eventOf(decline)).toContain('connect.job_application_declined');
  });

  it('withdrawApplication fires connect.job_application_withdrawn for the applicant', async () => {
    const f = build();
    const application: any = {
      _id: new Types.ObjectId(),
      jobId: JOB,
      applicantUserId: KARIGAR,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.applicationModel.findById = vi.fn().mockResolvedValue(application);

    await f.service.withdrawApplication(KARIGAR.toHexString(), String(application._id));

    const call = f.posthog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'connect.job_application_withdrawn',
    );
    expect(call).toBeDefined();
    expect(call[0].distinctId).toBe(KARIGAR.toHexString());
  });
});
