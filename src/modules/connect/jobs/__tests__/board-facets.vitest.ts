/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing JobsService so the transitive
// schema imports (Job, JobApplication, ...) don't trip vitest's reflect-metadata
// "Cannot determine type" error. Models are injected as plain mocks. Mirrors
// auth.service.audit.vitest.ts.
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

import { JobsService } from '../jobs.service';

/**
 * Facet-shape coverage for JobsService.boardFacets.
 *
 * Asserts:
 *   - one $facet aggregation with the 6 facet branches + a `total` branch;
 *   - each facet sub-pipeline EXCLUDES its own field from the $match (so the
 *     count answers "how many if I also pick this"), AND across the others;
 *   - the result is shaped {_id,count} -> {value,count}, null _id dropped;
 *   - a currently-selected value missing from the top-50 is UNIONED back in.
 *
 * jobModel.aggregate is mocked to (a) capture the pipeline and (b) return a
 * canned $facet result.
 */
describe('JobsService.boardFacets', () => {
  let svc: JobsService;
  let aggregate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aggregate = vi.fn();
    const jobModel: any = { aggregate };
    // Only jobModel is exercised by boardFacets; the rest are inert stubs.
    svc = new JobsService(
      jobModel,
      {} as any, // applicationModel
      {} as any, // jobViewModel
      {} as any, // savedJobModel
      {} as any, // userModel
      {} as any, // allowances
      {} as any, // companyPages
      {} as any, // notifications
      {} as any, // audit
      {} as any, // eventEmitter
      {} as any, // tagService
      undefined, // posthog
    );
  });

  it('builds one $facet with total + 6 facet branches, each minus its own field', async () => {
    aggregate.mockResolvedValue([
      {
        total: [{ n: 3 }],
        district: [{ _id: 'Varachha', count: 2 }],
        role: [{ _id: 'karigar', count: 3 }],
        employmentType: [{ _id: 'full_time', count: 1 }],
        machineType: [],
        skill: [{ _id: 'Aari', count: 2 }],
        wageType: [{ _id: 'monthly', count: 3 }],
      },
    ]);

    const res = await svc.boardFacets({ roles: 'karigar', districts: 'Varachha' } as any);

    // Captured pipeline.
    expect(aggregate).toHaveBeenCalledTimes(1);
    const pipeline = aggregate.mock.calls[0][0];
    const facetStage = pipeline[0].$facet;
    expect(Object.keys(facetStage).sort()).toEqual(
      ['district', 'employmentType', 'machineType', 'role', 'skill', 'total', 'wageType'].sort(),
    );

    // "minus own field": the district branch must NOT constrain location.district
    // (its own facet) but MUST still apply the role filter (cross-facet AND).
    const districtMatch = facetStage.district[0].$match;
    expect(districtMatch['location.district']).toBeUndefined();
    expect(districtMatch.role).toEqual({ $in: ['karigar'] });

    // The role branch is the mirror: drops role, keeps district.
    const roleMatch = facetStage.role[0].$match;
    expect(roleMatch.role).toBeUndefined();
    expect(roleMatch['location.district']).toBeDefined();

    // total branch keeps ALL active filters.
    const totalMatch = facetStage.total[0].$match;
    expect(totalMatch.role).toEqual({ $in: ['karigar'] });
    expect(totalMatch['location.district']).toBeDefined();

    // Shape: {_id,count} -> {value,count}, total = n.
    expect(res.total).toBe(3);
    expect(res.role).toEqual([{ value: 'karigar', count: 3 }]);
    expect(res.district).toEqual([{ value: 'Varachha', count: 2 }]);
  });

  it('drops null _id rows and unions-in a selected value absent from a facet', async () => {
    aggregate.mockResolvedValue([
      {
        total: [{ n: 1 }],
        district: [{ _id: 'Varachha', count: 1 }],
        // role facet has a null bucket (jobs with no role) + omits the selected
        // "operator" entirely (it fell outside the top-50 / has 0 matches now).
        role: [
          { _id: 'karigar', count: 1 },
          { _id: null, count: 4 },
        ],
        employmentType: [],
        machineType: [],
        skill: [],
        wageType: [],
      },
    ]);

    const res = await svc.boardFacets({ roles: 'karigar,operator' } as any);

    // null _id dropped.
    expect(res.role.find((e) => (e.value as any) === null)).toBeUndefined();
    // selected "operator" unioned back in at count 0 so it stays unselectable-able.
    const operator = res.role.find((e) => e.value === 'operator');
    expect(operator).toEqual({ value: 'operator', count: 0 });
    // present selected value keeps its real count.
    expect(res.role.find((e) => e.value === 'karigar')).toEqual({ value: 'karigar', count: 1 });
  });
});
