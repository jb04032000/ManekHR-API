/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 * Unit coverage for listOpenJobsByUser - the person-level public open-jobs read
 * behind the profile Hiring card. We assert the query issued is
 * { companyUserId: <ObjectId>, status: 'open' } and that {count, applicants,
 * jobs} is computed from the returned rows (applicants = sum of applicationsCount).
 */
describe('JobsService.listOpenJobsByUser', () => {
  let jobModel: any;
  let lastFindFilter: any;
  let rows: any[];
  let svc: JobsService;

  beforeEach(() => {
    rows = [];
    lastFindFilter = undefined;
    // Chainable query stub mirroring the service's find().sort().limit().lean().exec().
    jobModel = {
      find: vi.fn((filter: any) => {
        lastFindFilter = filter;
        const q: any = {
          sort: vi.fn(() => q),
          limit: vi.fn(() => q),
          lean: vi.fn(() => q),
          exec: vi.fn(() => Promise.resolve(rows)),
        };
        return q;
      }),
    };

    // Only jobModel is exercised; the remaining positional deps are unused by
    // listOpenJobsByUser so they are injected as nulls / minimal stubs.
    svc = new JobsService(
      jobModel,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      undefined,
      undefined,
    );
  });

  it('listOpenJobsByUser returns only that user open jobs with applicant tally', async () => {
    const u = new Types.ObjectId();
    rows = [{ title: 'A', category: 'embroidery', status: 'open', applicationsCount: 3 }];

    const res = await svc.listOpenJobsByUser(u.toString());

    // Query is keyed on the owning User + open status only.
    expect(jobModel.find).toHaveBeenCalledTimes(1);
    expect(lastFindFilter.status).toBe('open');
    expect(lastFindFilter.companyUserId).toBeInstanceOf(Types.ObjectId);
    expect(String(lastFindFilter.companyUserId)).toBe(u.toString());

    // Tally computed from the rows.
    expect(res.count).toBe(1);
    expect(res.applicants).toBe(3);
    expect(res.jobs[0].title).toBe('A');
  });

  it('sums applicationsCount across rows (treating a missing count as 0)', async () => {
    const u = new Types.ObjectId();
    rows = [
      { title: 'A', status: 'open', applicationsCount: 3 },
      { title: 'B', status: 'open' },
      { title: 'C', status: 'open', applicationsCount: 2 },
    ];

    const res = await svc.listOpenJobsByUser(u.toString());

    expect(res.count).toBe(3);
    expect(res.applicants).toBe(5);
  });

  it('returns an empty tally without querying on a malformed user id', async () => {
    const res = await svc.listOpenJobsByUser('not-a-mongo-id');

    expect(jobModel.find).not.toHaveBeenCalled();
    expect(res).toEqual({ count: 0, applicants: 0, jobs: [] });
  });
});
