import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';

/**
 * Pure-helper coverage for feed-post search (search redesign Phase B). Same
 * flavour as `listing-search.helpers.vitest.ts`: exercises the document mapper,
 * the card mapper, the filter builders, and the facet predicate without any
 * Nest / Mongoose decorator stack.
 */

import {
  buildPostDocument,
  buildPostMeiliFilter,
  buildPostMongoConditions,
  hasPostFilters,
  toPostRef,
  type PostForIndex,
  type PostForRef,
} from '../post-search.helpers';

const baseIndex: PostForIndex = {
  _id: new Types.ObjectId(),
  authorId: new Types.ObjectId(),
  body: '  Zari work on silk, bulk orders welcome  ',
  hashtags: ['zari', 'silk'],
  kind: 'text',
  authorErpLinked: true,
  reactionCount: 4,
  commentCount: 3,
  repostCount: 2,
  createdAt: new Date('2026-05-30T10:00:00.000Z'),
};

describe('hasPostFilters', () => {
  it('is false when no facet is set', () => {
    expect(hasPostFilters({})).toBe(false);
  });
  it('is true when kind or authorId is set', () => {
    expect(hasPostFilters({ kind: 'photo' })).toBe(true);
    expect(hasPostFilters({ authorId: 'u1' })).toBe(true);
  });
});

describe('buildPostDocument', () => {
  it('maps a post into the indexed shape, trimming the body', () => {
    const doc = buildPostDocument(baseIndex);
    expect(doc.body).toBe('Zari work on silk, bulk orders welcome');
    expect(doc.hashtags).toEqual(['zari', 'silk']);
    expect(doc.kind).toBe('text');
    expect(doc.authorErpLinked).toBe(true);
    expect(doc.createdAt).toBe(new Date('2026-05-30T10:00:00.000Z').getTime());
  });

  it('sums reactions + comments + reposts into engagementScore', () => {
    expect(buildPostDocument(baseIndex).engagementScore).toBe(9);
  });

  it('romanizes Gujarati body + hashtags into the `romanized` recall field (SRCH-I18N-1)', () => {
    const doc = buildPostDocument({
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      body: 'સાડી work',
      kind: 'text',
      hashtags: ['જરી'],
    });
    expect(doc.romanized).toContain('sadi');
    expect(doc.romanized).toContain('jari');
  });

  it('leaves `romanized` empty for an all-Latin post', () => {
    const doc = buildPostDocument({
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      body: 'zari saree work',
      kind: 'text',
      hashtags: ['silk'],
    });
    expect(doc.romanized).toBe('');
  });

  it('defaults missing optional fields', () => {
    const doc = buildPostDocument({
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      kind: 'photo',
    });
    expect(doc.body).toBe('');
    expect(doc.hashtags).toEqual([]);
    expect(doc.authorErpLinked).toBe(false);
    expect(doc.engagementScore).toBe(0);
  });
});

describe('toPostRef', () => {
  const baseRef: PostForRef = {
    _id: new Types.ObjectId(),
    authorId: new Types.ObjectId(),
    body: 'Short body',
    kind: 'photo',
    media: [
      { url: 'https://img/doc.pdf', type: 'document' },
      { url: 'https://img/cover.jpg', type: 'image' },
    ],
    reactionCount: 5,
    commentCount: 1,
    createdAt: new Date('2026-05-30T10:00:00.000Z'),
  };

  it('picks the first image/video attachment as the cover', () => {
    expect(toPostRef(baseRef).coverImage).toBe('https://img/cover.jpg');
  });

  it('returns a null cover for a text post with no media', () => {
    expect(toPostRef({ ...baseRef, media: [] }).coverImage).toBeNull();
  });

  it('truncates a long body to a snippet with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const ref = toPostRef({ ...baseRef, body: long });
    expect(ref.snippet.endsWith('...')).toBe(true);
    expect(ref.snippet.length).toBeLessThanOrEqual(164);
  });

  it('keeps a short body intact', () => {
    expect(toPostRef(baseRef).snippet).toBe('Short body');
  });
});

describe('buildPostMeiliFilter', () => {
  it('adds kind + author clauses when set', () => {
    const clauses = buildPostMeiliFilter({ kind: 'voice', authorId: '64a000000000000000000001' });
    expect(clauses).toContain('kind = "voice"');
    expect(clauses).toContain('authorId = "64a000000000000000000001"');
  });
  it('is empty with no facets (the index already holds public-only posts)', () => {
    expect(buildPostMeiliFilter({})).toEqual([]);
  });
});

describe('buildPostMongoConditions', () => {
  it('always pins the public gate: public + not-deleted + original-not-repost', () => {
    const c = buildPostMongoConditions({});
    expect(c.visibility).toBe('public');
    expect(c.deletedAt).toBeNull();
    expect(c.repostOf).toBeNull();
  });
  it('coerces authorId to an ObjectId and forwards kind', () => {
    const id = '64a000000000000000000002';
    const c = buildPostMongoConditions({ kind: 'document', authorId: id });
    expect(c.kind).toBe('document');
    expect(c.authorId).toBeInstanceOf(Types.ObjectId);
    expect(String(c.authorId)).toBe(id);
  });
});
