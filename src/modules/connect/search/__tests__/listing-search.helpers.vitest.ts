import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';

/**
 * Pure-helper coverage for marketplace listing search (M1.4). Same flavour as
 * `people-search.helpers.vitest.ts` - exercises the document mapper, filter
 * builders, and facet predicate without any Nest / Mongoose decorator stack.
 */

import {
  buildListingDocument,
  buildListingMeiliFilter,
  buildListingMongoConditions,
  buildListingSort,
  normalizeListingSort,
  applyVerifiedRefFilter,
  applyVerifiedFirstOrder,
  hasListingFilters,
  toListingRef,
  LISTING_SORTS,
  type ConnectListingRef,
  type ListingForIndex,
  type ListingForRef,
} from '../listing-search.helpers';

const baseListing: ListingForIndex = {
  _id: new Types.ObjectId(),
  ownerUserId: new Types.ObjectId(),
  title: '  Heavy zari saree work  ',
  description: '  Hand-finished zardozi on silk  ',
  category: 'embroidery-zari',
  priceType: 'range',
  priceMin: 4500,
  priceMax: 8500,
  unit: 'per-piece',
  location: { district: '  Surat  ' },
  images: ['a.jpg', 'b.jpg'],
  createdAt: new Date('2026-05-28T12:00:00.000Z'),
};

describe('hasListingFilters', () => {
  it('is false when every filter is absent', () => {
    expect(hasListingFilters({})).toBe(false);
  });

  it('treats a whitespace-only district as no filter', () => {
    expect(hasListingFilters({ district: '   ' })).toBe(false);
  });

  it('is true when category is set', () => {
    expect(hasListingFilters({ category: 'weaving' })).toBe(true);
  });

  it('is true when categoryIn is a non-empty set', () => {
    expect(hasListingFilters({ categoryIn: ['consulting', 'maintenance'] })).toBe(true);
  });

  it('is false when categoryIn is an empty array (no narrowing)', () => {
    expect(hasListingFilters({ categoryIn: [] })).toBe(false);
  });

  it('is true when either price bound is set', () => {
    expect(hasListingFilters({ priceMin: 1000 })).toBe(true);
    expect(hasListingFilters({ priceMax: 1000 })).toBe(true);
  });

  it('is true when ownerUserId is set', () => {
    expect(hasListingFilters({ ownerUserId: 'u1' })).toBe(true);
  });

  it('is true when tags array is non-empty', () => {
    expect(hasListingFilters({ tags: ['kanjivaram'] })).toBe(true);
  });

  it('is false when tags array is empty', () => {
    expect(hasListingFilters({ tags: [] })).toBe(false);
  });

  it('is true when verified is true', () => {
    expect(hasListingFilters({ verified: true })).toBe(true);
  });

  it('is false when verified is explicitly false (no narrowing)', () => {
    expect(hasListingFilters({ verified: false })).toBe(false);
  });

  it('does not treat a sort on its own as a filter (sort orders, it does not narrow)', () => {
    expect(hasListingFilters({ sort: 'price_low' })).toBe(false);
  });
});

describe('buildListingDocument', () => {
  it('maps a listing into the indexed shape with district lower-cased', () => {
    const doc = buildListingDocument(baseListing);
    expect(doc.title).toBe('Heavy zari saree work');
    expect(doc.description).toBe('Hand-finished zardozi on silk');
    expect(doc.category).toBe('embroidery-zari');
    expect(doc.district).toBe('surat');
    expect(doc.priceMin).toBe(4500);
    expect(doc.priceMax).toBe(8500);
    expect(doc.unit).toBe('per-piece');
    expect(doc.status).toBe('active');
    expect(doc.moderationStatus).toBe('approved');
    expect(doc.images).toEqual(['a.jpg', 'b.jpg']);
    expect(doc.createdAt).toBe(new Date('2026-05-28T12:00:00.000Z').getTime());
  });

  it('defaults missing optional fields to null / empty', () => {
    const minimal: ListingForIndex = {
      _id: new Types.ObjectId(),
      ownerUserId: new Types.ObjectId(),
      title: 'Saree',
      category: 'finished-goods',
      priceType: 'negotiable',
    };
    const doc = buildListingDocument(minimal);
    expect(doc.description).toBe('');
    expect(doc.priceMin).toBeNull();
    expect(doc.priceMax).toBeNull();
    expect(doc.unit).toBeNull();
    expect(doc.district).toBe('');
    expect(doc.images).toEqual([]);
    // A legacy listing with no shop indexes a null storefrontId (not undefined).
    expect(doc.storefrontId).toBeNull();
  });

  it('stamps the storefrontId (stringified) when the listing belongs to a shop', () => {
    const storefrontId = new Types.ObjectId();
    const doc = buildListingDocument({ ...baseListing, storefrontId });
    expect(doc.storefrontId).toBe(String(storefrontId));
  });

  it('stamps the owner verified flag + searchPriority signal (M2.3)', () => {
    const doc = buildListingDocument(baseListing, { verified: true, searchPriority: 5 });
    expect(doc.verified).toBe(true);
    expect(doc.searchPriority).toBe(5);
  });

  it('defaults verified=false + searchPriority=0 when no owner signals are given', () => {
    const doc = buildListingDocument(baseListing);
    expect(doc.verified).toBe(false);
    expect(doc.searchPriority).toBe(0);
  });

  it('maps listing.tags into the indexed document', () => {
    const doc = buildListingDocument({ ...baseListing, tags: ['kanjivaram'] });
    expect(doc.tags).toEqual(['kanjivaram']);
  });

  it('defaults tags to [] when the listing has no tags', () => {
    const minimal: ListingForIndex = {
      _id: new Types.ObjectId(),
      ownerUserId: new Types.ObjectId(),
      title: 'Saree',
      category: 'finished-goods',
      priceType: 'negotiable',
    };
    const doc = buildListingDocument(minimal);
    expect(doc.tags).toEqual([]);
  });

  it('romanizes a Gujarati title + tags into the `romanized` recall field (SRCH-I18N-1)', () => {
    const doc = buildListingDocument({
      _id: new Types.ObjectId(),
      ownerUserId: new Types.ObjectId(),
      title: 'સાડી',
      category: 'embroidery-zari',
      priceType: 'fixed',
      tags: ['જરી'],
    });
    expect(doc.romanized).toContain('sadi');
    expect(doc.romanized).toContain('jari');
  });
});

describe('toListingRef', () => {
  const baseRef: ListingForRef = {
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    title: 'Heavy zari saree work',
    description: 'Hand-finished zardozi on silk',
    category: 'embroidery-zari',
    priceType: 'range',
    priceMin: 4500,
    priceMax: 8500,
    unit: 'per-piece',
    location: { district: 'Surat' },
    images: ['a.jpg'],
    createdAt: new Date('2026-05-28T12:00:00.000Z'),
  };

  it('preserves district casing and picks the first image as the cover', () => {
    const ref = toListingRef(baseRef);
    expect(ref.district).toBe('Surat');
    expect(ref.coverImage).toBe('a.jpg');
  });

  it('carries the owner verified flag when supplied (M2.3)', () => {
    expect(toListingRef(baseRef, { verified: true }).verified).toBe(true);
  });

  it('defaults verified to false when no owner signal is given', () => {
    expect(toListingRef(baseRef).verified).toBe(false);
  });

  it('sets hasVideo from the listing videos array (drives the card play badge)', () => {
    expect(toListingRef(baseRef).hasVideo).toBe(false);
    expect(toListingRef({ ...baseRef, videos: [] }).hasVideo).toBe(false);
    expect(toListingRef({ ...baseRef, videos: [{ url: 'clip.mp4' }] }).hasVideo).toBe(true);
  });

  it('carries null courseDetails for a non-course listing', () => {
    expect(toListingRef(baseRef).courseDetails).toBeNull();
  });

  it('maps courseDetails onto the card for a course listing (Institutes Phase 1)', () => {
    const courseRef: ListingForRef = {
      ...baseRef,
      category: 'course',
      courseDetails: {
        durationLabel: '6 weeks',
        batchStart: new Date('2026-07-01T00:00:00.000Z'),
        mode: 'offline',
        feeType: 'fixed',
        seats: 20,
        certificate: true,
        skillsTaught: ['digitising'],
      },
    };
    expect(toListingRef(courseRef).courseDetails).toEqual({
      durationLabel: '6 weeks',
      batchStart: '2026-07-01T00:00:00.000Z',
      mode: 'offline',
      feeType: 'fixed',
      seats: 20,
      certificate: true,
      skillsTaught: ['digitising'],
    });
  });
});

describe('buildListingMeiliFilter', () => {
  it('always pins the public gate when publicOnly is true (the default)', () => {
    const clauses = buildListingMeiliFilter({});
    expect(clauses).toContain("status = 'active'");
    expect(clauses).toContain("moderationStatus = 'approved'");
  });

  it('omits the public gate when publicOnly is false', () => {
    const clauses = buildListingMeiliFilter({}, { publicOnly: false });
    expect(clauses).not.toContain("status = 'active'");
    expect(clauses).not.toContain("moderationStatus = 'approved'");
  });

  it('forwards category as a quoted equality match', () => {
    const clauses = buildListingMeiliFilter({ category: 'weaving' }, { publicOnly: false });
    expect(clauses).toContain('category = "weaving"');
  });

  it('forwards categoryIn as a single quoted IN [...] set clause (mirrors skills IN)', () => {
    const clauses = buildListingMeiliFilter(
      { categoryIn: ['consulting', 'maintenance'] },
      { publicOnly: false },
    );
    expect(clauses).toContain('category IN ["consulting", "maintenance"]');
  });

  it('prefers categoryIn over a single category when both are sent', () => {
    const clauses = buildListingMeiliFilter(
      { category: 'weaving', categoryIn: ['consulting', 'maintenance'] },
      { publicOnly: false },
    );
    expect(clauses).toContain('category IN ["consulting", "maintenance"]');
    expect(clauses).not.toContain('category = "weaving"');
  });

  it('ignores an empty categoryIn and keeps the single category clause', () => {
    const clauses = buildListingMeiliFilter(
      { category: 'weaving', categoryIn: [] },
      { publicOnly: false },
    );
    expect(clauses).toContain('category = "weaving"');
    expect(clauses).not.toContain('category IN');
  });

  it('lower-cases district and quotes it for Meili', () => {
    const clauses = buildListingMeiliFilter({ district: ' Surat ' }, { publicOnly: false });
    expect(clauses).toContain('district = "surat"');
  });

  it('translates price bounds into priceMin range clauses', () => {
    const clauses = buildListingMeiliFilter(
      { priceMin: 1000, priceMax: 5000 },
      { publicOnly: false },
    );
    expect(clauses).toContain('priceMin >= 1000');
    expect(clauses).toContain('priceMin <= 5000');
  });

  it('forwards ownerUserId as a quoted equality clause', () => {
    const clauses = buildListingMeiliFilter(
      { ownerUserId: '64a000000000000000000001' },
      { publicOnly: false },
    );
    expect(clauses).toContain('ownerUserId = "64a000000000000000000001"');
  });

  it('forwards storefrontId as a quoted equality clause', () => {
    const clauses = buildListingMeiliFilter(
      { storefrontId: '64a000000000000000000009' },
      { publicOnly: false },
    );
    expect(clauses).toContain('storefrontId = "64a000000000000000000009"');
  });

  it('forwards a single tag as a quoted equality clause mirroring the category style', () => {
    const clauses = buildListingMeiliFilter({ tags: ['kanjivaram'] }, { publicOnly: false });
    expect(clauses).toContain('tags = "kanjivaram"');
  });

  it('emits one clause per tag (AND-joined via the clause array) for multiple tags', () => {
    const clauses = buildListingMeiliFilter(
      { tags: ['kanjivaram', 'zardozi'] },
      { publicOnly: false },
    );
    expect(clauses).toContain('tags = "kanjivaram"');
    expect(clauses).toContain('tags = "zardozi"');
  });

  it('escapes double-quotes inside a tag value', () => {
    const clauses = buildListingMeiliFilter({ tags: ['say "hi"'] }, { publicOnly: false });
    expect(clauses).toContain('tags = "say \\"hi\\""');
  });

  it('adds a verified = true clause when the verified facet is set', () => {
    const clauses = buildListingMeiliFilter({ verified: true }, { publicOnly: false });
    expect(clauses).toContain('verified = true');
  });

  it('omits the verified clause when verified is false or absent', () => {
    expect(buildListingMeiliFilter({ verified: false }, { publicOnly: false })).not.toContain(
      'verified = true',
    );
    expect(buildListingMeiliFilter({}, { publicOnly: false })).not.toContain('verified = true');
  });
});

describe('buildListingMongoConditions', () => {
  it('pins the public gate by default', () => {
    const conditions = buildListingMongoConditions({});
    expect(conditions.status).toBe('active');
    expect(conditions.moderationStatus).toBe('approved');
  });

  it('lifts the price bounds onto a single priceMin range expression', () => {
    const conditions = buildListingMongoConditions(
      { priceMin: 1000, priceMax: 5000 },
      { publicOnly: false },
    );
    expect(conditions.priceMin).toEqual({ $gte: 1000, $lte: 5000 });
  });

  it('matches a single category with an equality condition', () => {
    const conditions = buildListingMongoConditions({ category: 'weaving' }, { publicOnly: false });
    expect(conditions.category).toBe('weaving');
  });

  it('matches categoryIn with a $in set condition', () => {
    const conditions = buildListingMongoConditions(
      { categoryIn: ['consulting', 'maintenance'] },
      { publicOnly: false },
    );
    expect(conditions.category).toEqual({ $in: ['consulting', 'maintenance'] });
  });

  it('prefers categoryIn over a single category when both are sent', () => {
    const conditions = buildListingMongoConditions(
      { category: 'weaving', categoryIn: ['consulting', 'maintenance'] },
      { publicOnly: false },
    );
    expect(conditions.category).toEqual({ $in: ['consulting', 'maintenance'] });
  });

  it('ignores an empty categoryIn and keeps the single category equality', () => {
    const conditions = buildListingMongoConditions(
      { category: 'weaving', categoryIn: [] },
      { publicOnly: false },
    );
    expect(conditions.category).toBe('weaving');
  });

  it('matches district case-insensitively with regex anchors', () => {
    const conditions = buildListingMongoConditions({ district: 'Surat' }, { publicOnly: false });
    const rx = conditions['location.district'] as RegExp;
    expect(rx).toBeInstanceOf(RegExp);
    expect(rx.test('surat')).toBe(true);
    expect(rx.test('SURAT')).toBe(true);
    expect(rx.test('surat-2')).toBe(false);
  });

  it('coerces ownerUserId to an ObjectId for the Mongo query', () => {
    const id = '64a000000000000000000002';
    const conditions = buildListingMongoConditions({ ownerUserId: id }, { publicOnly: false });
    expect(conditions.ownerUserId).toBeInstanceOf(Types.ObjectId);
    expect(String(conditions.ownerUserId)).toBe(id);
  });

  it('coerces storefrontId to an ObjectId for the Mongo query', () => {
    const id = '64a000000000000000000003';
    const conditions = buildListingMongoConditions({ storefrontId: id }, { publicOnly: false });
    expect(conditions.storefrontId).toBeInstanceOf(Types.ObjectId);
    expect(String(conditions.storefrontId)).toBe(id);
  });

  it('adds a $all clause for tags so a listing must carry all requested slugs (AND semantics)', () => {
    const conditions = buildListingMongoConditions({ tags: ['kanjivaram'] }, { publicOnly: false });
    expect(conditions.tags).toEqual({ $all: ['kanjivaram'] });
  });

  it('passes multiple tags through the $all clause', () => {
    const conditions = buildListingMongoConditions(
      { tags: ['kanjivaram', 'zardozi'] },
      { publicOnly: false },
    );
    expect(conditions.tags).toEqual({ $all: ['kanjivaram', 'zardozi'] });
  });

  it('omits the tags condition when the tags array is empty', () => {
    const conditions = buildListingMongoConditions({ tags: [] }, { publicOnly: false });
    expect(conditions).not.toHaveProperty('tags');
  });

  it('never emits a `verified` Mongo condition (verified is a post-hydration owner signal, not a Listing field)', () => {
    const conditions = buildListingMongoConditions({ verified: true }, { publicOnly: false });
    expect(conditions).not.toHaveProperty('verified');
  });
});

describe('normalizeListingSort', () => {
  it('defaults an absent sort to "recent"', () => {
    expect(normalizeListingSort(undefined)).toBe('recent');
  });

  it('defaults an unknown sort key to "recent"', () => {
    expect(normalizeListingSort('bogus')).toBe('recent');
  });

  it('falls back top_rated to recent (seller rating is not denormalized onto the listing)', () => {
    expect(normalizeListingSort('top_rated')).toBe('recent');
  });

  it('passes through each supported real sort value unchanged', () => {
    expect(normalizeListingSort('recent')).toBe('recent');
    expect(normalizeListingSort('price_low')).toBe('price_low');
    expect(normalizeListingSort('price_high')).toBe('price_high');
    expect(normalizeListingSort('verified_first')).toBe('verified_first');
  });

  it('exposes the canonical web-contract sort enum', () => {
    expect(LISTING_SORTS).toEqual([
      'recent',
      'price_low',
      'price_high',
      'verified_first',
      'top_rated',
    ]);
  });
});

describe('buildListingSort', () => {
  it('defaults (recent) to newest-first on both backends', () => {
    const sort = buildListingSort(undefined);
    expect(sort.key).toBe('recent');
    expect(sort.meili).toEqual(['createdAt:desc']);
    expect(sort.mongo).toEqual({ createdAt: -1 });
  });

  it('maps recent to createdAt-desc', () => {
    const sort = buildListingSort('recent');
    expect(sort.meili).toEqual(['createdAt:desc']);
    expect(sort.mongo).toEqual({ createdAt: -1 });
  });

  it('maps price_low to ascending price floor (cheapest first)', () => {
    const sort = buildListingSort('price_low');
    expect(sort.meili).toEqual(['priceMin:asc']);
    expect(sort.mongo).toEqual({ priceMin: 1 });
  });

  it('maps price_high to descending price ceiling, then floor (dearest first)', () => {
    const sort = buildListingSort('price_high');
    expect(sort.meili).toEqual(['priceMax:desc', 'priceMin:desc']);
    expect(sort.mongo).toEqual({ priceMax: -1, priceMin: -1 });
  });

  it('maps verified_first to verified-desc then newest', () => {
    const sort = buildListingSort('verified_first');
    expect(sort.meili).toEqual(['verified:desc', 'createdAt:desc']);
    expect(sort.mongo).toEqual({ createdAt: -1 });
  });

  it('falls back an unknown sort to recent', () => {
    const sort = buildListingSort('bogus');
    expect(sort.key).toBe('recent');
    expect(sort.meili).toEqual(['createdAt:desc']);
    expect(sort.mongo).toEqual({ createdAt: -1 });
  });

  it('falls back top_rated to recent (rating is a cross-collection join, not on the listing doc)', () => {
    const sort = buildListingSort('top_rated');
    expect(sort.key).toBe('recent');
    expect(sort.meili).toEqual(['createdAt:desc']);
    expect(sort.mongo).toEqual({ createdAt: -1 });
  });
});

describe('applyVerifiedRefFilter', () => {
  const ref = (id: string, verified: boolean): ConnectListingRef =>
    ({ listingId: id, ownerUserId: 'o', verified }) as unknown as ConnectListingRef;

  it('returns the page untouched when verified is not requested', () => {
    const page = [ref('a', false), ref('b', true)];
    expect(applyVerifiedRefFilter(page, undefined)).toBe(page);
    expect(applyVerifiedRefFilter(page, false)).toBe(page);
  });

  it('keeps only verified cards when verified is requested', () => {
    const page = [ref('a', false), ref('b', true), ref('c', false), ref('d', true)];
    const kept = applyVerifiedRefFilter(page, true);
    expect(kept.map((r) => r.listingId)).toEqual(['b', 'd']);
  });
});

describe('applyVerifiedFirstOrder', () => {
  const ref = (id: string, verified: boolean): ConnectListingRef =>
    ({ listingId: id, ownerUserId: 'o', verified }) as unknown as ConnectListingRef;

  it('hoists verified cards ahead of unverified, preserving relative order (stable)', () => {
    const page = [ref('a', false), ref('b', true), ref('c', false), ref('d', true)];
    const ordered = applyVerifiedFirstOrder(page, 'verified_first');
    expect(ordered.map((r) => r.listingId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('is a no-op for any other sort key', () => {
    const page = [ref('a', false), ref('b', true)];
    expect(applyVerifiedFirstOrder(page, 'recent')).toBe(page);
    expect(applyVerifiedFirstOrder(page, 'price_low')).toBe(page);
  });
});
