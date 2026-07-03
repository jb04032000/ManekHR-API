/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose decorators BEFORE importing JobsService so the
// transitive schema imports (Job, JobApplication, etc.) don't trip the
// "Cannot determine type" reflection error under vitest's esbuild transform.
// The Job model is injected as a plain chainable mock (no real Mongoose).
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

/**
 * Unit coverage for getPublicJob - the @Public single-job read behind the
 * logged-out web /jobs/[id] SEO page. Contract:
 *   - an OPEN job is returned (the same Job shape, no applicant data);
 *   - a closed / filled job throws NotFound (off the board = invisible to crawlers);
 *   - a missing / malformed id throws NotFound;
 *   - an open-but-suppressed job (over-limit hide_newest) throws NotFound.
 */
describe('JobsService.getPublicJob', () => {
  let jobModel: any;
  let found: any;
  let overLimit: any;
  let svc: JobsService;

  /** Build the service with an optional over-limit stub (last positional dep). */
  const build = (over?: any): JobsService =>
    new JobsService(
      jobModel,
      null as any, // applicationModel
      null as any, // jobViewModel
      null as any, // savedJobModel
      null as any, // userModel
      null as any, // allowances
      null as any, // companyPages
      null as any, // notifications
      null as any, // audit
      null as any, // eventEmitter
      null as any, // tagService
      undefined, // posthog
      undefined, // jobBoosts
      undefined as any, // media
      undefined, // privateMedia
      over, // overLimit
    );

  beforeEach(() => {
    found = null;
    // findById(id).lean().exec() chain.
    jobModel = {
      findById: vi.fn(() => ({
        lean: vi.fn(() => ({ exec: vi.fn(() => Promise.resolve(found)) })),
      })),
    };
    overLimit = { getSuppressedIds: vi.fn(() => Promise.resolve([] as string[])) };
    svc = build(overLimit);
  });

  it('returns an OPEN job', async () => {
    const id = new Types.ObjectId();
    found = { _id: id, companyUserId: new Types.ObjectId(), title: 'Aari karigar', status: 'open' };

    const res = await svc.getPublicJob(id.toString());

    expect(res).toBe(found);
    expect(jobModel.findById).toHaveBeenCalledTimes(1);
  });

  it('throws NotFound for a CLOSED job', async () => {
    const id = new Types.ObjectId();
    found = { _id: id, companyUserId: new Types.ObjectId(), title: 'Closed', status: 'closed' };

    await expect(svc.getPublicJob(id.toString())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound for a FILLED job', async () => {
    const id = new Types.ObjectId();
    found = { _id: id, companyUserId: new Types.ObjectId(), title: 'Filled', status: 'filled' };

    await expect(svc.getPublicJob(id.toString())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound for a missing job (valid id, no document)', async () => {
    const id = new Types.ObjectId();
    found = null;

    await expect(svc.getPublicJob(id.toString())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound for a malformed id (no DB hit)', async () => {
    await expect(svc.getPublicJob('not-an-objectid')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobModel.findById).not.toHaveBeenCalled();
  });

  it('throws NotFound for an open-but-suppressed job (over-limit hide_newest)', async () => {
    const id = new Types.ObjectId();
    found = { _id: id, companyUserId: new Types.ObjectId(), title: 'Hidden', status: 'open' };
    overLimit.getSuppressedIds.mockResolvedValue([id.toString()]);

    await expect(svc.getPublicJob(id.toString())).rejects.toBeInstanceOf(NotFoundException);
    expect(overLimit.getSuppressedIds).toHaveBeenCalledWith(String(found.companyUserId), 'job');
  });

  it('returns an open job when the over-limit service is absent (freeze / unit ctor)', async () => {
    const id = new Types.ObjectId();
    found = { _id: id, companyUserId: new Types.ObjectId(), title: 'Open', status: 'open' };
    svc = build(undefined);

    const res = await svc.getPublicJob(id.toString());
    expect(res).toBe(found);
  });
});
