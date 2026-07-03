import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';

/**
 * Pure-helper coverage for Connect job search (Phase 5). Same flavour as
 * `listing-search.helpers.vitest.ts` - exercises the document mapper, the ref
 * projection, the filter builders, and the facet predicate without any Nest /
 * Mongoose decorator stack. The job index holds only OPEN jobs, so the Mongo
 * conditions always pin `status: 'open'`.
 */

import {
  buildJobDocument,
  buildJobMeiliFilter,
  buildJobMongoConditions,
  hasJobFilters,
  toJobRef,
  type JobForIndex,
  type JobForRef,
} from '../job-search.helpers';

const baseJob: JobForIndex = {
  _id: new Types.ObjectId(),
  title: '  Zari embroidery karigar wanted  ',
  description: '  Daily wage, Surat workshop  ',
  category: 'embroidery-zari',
  role: 'karigar',
  companyUserId: new Types.ObjectId(),
  companyPageId: new Types.ObjectId(),
  location: { district: 'Surat' },
  createdAt: new Date('2026-05-29T10:00:00.000Z'),
};

describe('hasJobFilters', () => {
  it('is false when every filter is absent', () => {
    expect(hasJobFilters({})).toBe(false);
  });

  it('is true when category is set', () => {
    expect(hasJobFilters({ category: 'weaving' })).toBe(true);
  });

  it('is true when companyPageId is set', () => {
    expect(hasJobFilters({ companyPageId: '64a000000000000000000001' })).toBe(true);
  });
});

describe('buildJobDocument', () => {
  it('maps a job into the indexed shape, trimming text', () => {
    const doc = buildJobDocument(baseJob);
    expect(doc.id).toBe(String(baseJob._id));
    expect(doc.title).toBe('Zari embroidery karigar wanted');
    expect(doc.description).toBe('Daily wage, Surat workshop');
    expect(doc.category).toBe('embroidery-zari');
    expect(doc.role).toBe('karigar');
    expect(doc.companyUserId).toBe(String(baseJob.companyUserId));
    expect(doc.companyPageId).toBe(String(baseJob.companyPageId));
    expect(doc.district).toBe('Surat');
    expect(doc.createdAt).toBe(new Date('2026-05-29T10:00:00.000Z').getTime());
  });

  it('defaults missing optional fields to empty / null', () => {
    const minimal: JobForIndex = {
      _id: new Types.ObjectId(),
      title: 'Weaver',
      category: 'weaving',
      companyUserId: new Types.ObjectId(),
    };
    const doc = buildJobDocument(minimal);
    expect(doc.description).toBe('');
    expect(doc.role).toBe('');
    expect(doc.companyPageId).toBeNull();
    expect(doc.district).toBe('');
  });

  it('romanizes a Gujarati title into the `romanized` recall field (SRCH-I18N-1)', () => {
    const doc = buildJobDocument({
      _id: new Types.ObjectId(),
      title: 'સાડી karigar',
      category: 'embroidery-zari',
      companyUserId: new Types.ObjectId(),
    });
    expect(doc.romanized).toContain('sadi');
  });
});

describe('toJobRef', () => {
  const baseRef: JobForRef = {
    _id: new Types.ObjectId(),
    companyUserId: new Types.ObjectId(),
    companyPageId: new Types.ObjectId(),
    title: 'Zari karigar',
    description: 'Piece rate',
    category: 'embroidery-zari',
    role: 'karigar',
    wageType: 'piece',
    wageMin: 50,
    wageMax: 80,
    openings: 3,
    location: { district: 'Surat' },
    status: 'open',
    applicationsCount: 2,
    createdAt: new Date('2026-05-29T10:00:00.000Z'),
  };

  it('projects a render-ready card mirroring the web Job shape', () => {
    const ref = toJobRef(baseRef);
    expect(ref._id).toBe(String(baseRef._id));
    expect(ref.companyPageId).toBe(String(baseRef.companyPageId));
    expect(ref.role).toBe('karigar');
    expect(ref.wageType).toBe('piece');
    expect(ref.openings).toBe(3);
    expect(ref.status).toBe('open');
    expect(ref.applicationsCount).toBe(2);
  });

  it('defaults the optional numeric / link fields', () => {
    const ref = toJobRef({
      _id: new Types.ObjectId(),
      companyUserId: new Types.ObjectId(),
      title: 'Weaver',
      category: 'weaving',
      status: 'open',
    });
    expect(ref.companyPageId).toBeNull();
    expect(ref.role).toBeNull();
    expect(ref.wageType).toBeNull();
    expect(ref.wageMin).toBeNull();
    expect(ref.wageMax).toBeNull();
    expect(ref.openings).toBe(1);
    expect(ref.applicationsCount).toBe(0);
    expect(ref.boostCampaignId).toBeNull();
    expect(ref.location).toEqual({});
  });
});

describe('buildJobMeiliFilter', () => {
  it('is empty when no facet is set (the index already holds only open jobs)', () => {
    expect(buildJobMeiliFilter({})).toEqual([]);
  });

  it('forwards category as a quoted equality match', () => {
    expect(buildJobMeiliFilter({ category: 'weaving' })).toContain('category = "weaving"');
  });

  it('forwards companyPageId as a quoted equality match', () => {
    const clauses = buildJobMeiliFilter({ companyPageId: '64a000000000000000000001' });
    expect(clauses).toContain('companyPageId = "64a000000000000000000001"');
  });
});

describe('buildJobMongoConditions', () => {
  it('always pins status: open', () => {
    expect(buildJobMongoConditions({}).status).toBe('open');
  });

  it('forwards category as-is', () => {
    expect(buildJobMongoConditions({ category: 'weaving' }).category).toBe('weaving');
  });

  it('coerces companyPageId to an ObjectId', () => {
    const id = '64a000000000000000000002';
    const conditions = buildJobMongoConditions({ companyPageId: id });
    expect(conditions.companyPageId).toBeInstanceOf(Types.ObjectId);
    expect(String(conditions.companyPageId)).toBe(id);
  });
});
