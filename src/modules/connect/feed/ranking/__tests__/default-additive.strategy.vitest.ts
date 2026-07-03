import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { DefaultAdditiveStrategy } from '../default-additive.strategy';
import type { FeedPost } from '../../feed.service';
import type { RankingSignals } from '../../../profile/connect-profile.service';
import type { RankingContext } from '../feed-ranking-strategy.interface';

/** A minimal valid `FeedPost` — override only the ranking-relevant fields. */
function post(over: Partial<FeedPost> = {}): FeedPost {
  return {
    _id: new Types.ObjectId(),
    authorId: new Types.ObjectId(),
    kind: 'text',
    body: '',
    media: [],
    audio: null,
    hashtags: [],
    tags: [],
    visibility: 'public',
    reactionCount: 0,
    commentCount: 0,
    viewCount: 0,
    repostCount: 0,
    authorErpLinked: false,
    authorSkills: [],
    createdAt: new Date(),
    ...over,
  };
}

const NOW = Date.now();
const ctx: RankingContext = { now: NOW, tab: 'foryou', viewerId: new Types.ObjectId() };
const noSignals: RankingSignals = {
  skills: [],
  openTo: { work: false, hiring: false, deals: false, customOrders: false },
  district: '',
  isDemo: false,
};

describe('DefaultAdditiveStrategy — For You ranking math (Phase 7b)', () => {
  const strat = new DefaultAdditiveStrategy();

  it('exposes the strategy key', () => {
    expect(strat.key).toBe('default-additive');
  });

  it('ranks an ERP-linked author above a non-linked one, all else equal', () => {
    const linked = post({ authorErpLinked: true, createdAt: new Date(NOW) });
    const plain = post({ authorErpLinked: false, createdAt: new Date(NOW) });
    expect(strat.rank([plain, linked], noSignals, ctx)[0]).toBe(linked);
  });

  it('ranks a fresher post above an older one (recency decay)', () => {
    const fresh = post({ createdAt: new Date(NOW) });
    const old = post({ createdAt: new Date(NOW - 48 * 3_600_000) });
    expect(strat.rank([old, fresh], noSignals, ctx)[0]).toBe(fresh);
  });

  it('lifts a post whose author shares a skill with the viewer', () => {
    const signals: RankingSignals = {
      skills: ['Zari'],
      openTo: { work: false, hiring: false, deals: false, customOrders: false },
      district: '',
      isDemo: false,
    };
    const shared = post({ authorSkills: ['Zari'], createdAt: new Date(NOW) });
    const none = post({ authorSkills: ['Welding'], createdAt: new Date(NOW) });
    expect(strat.rank([none, shared], signals, ctx)[0]).toBe(shared);
  });

  it('lifts a hiring-tagged post for a work-seeking viewer (persona term)', () => {
    const signals: RankingSignals = {
      skills: [],
      openTo: { work: true, hiring: false, deals: false, customOrders: false },
      district: '',
      isDemo: false,
    };
    const hiring = post({ tags: ['Hiring karigars'], createdAt: new Date(NOW) });
    const plain = post({ tags: [], createdAt: new Date(NOW) });
    expect(strat.rank([plain, hiring], signals, ctx)[0]).toBe(hiring);
  });

  it('lifts a post by an author the viewer has high affinity with (B3)', () => {
    const favourite = new Types.ObjectId();
    const liked = post({ authorId: favourite, createdAt: new Date(NOW) });
    const stranger = post({ createdAt: new Date(NOW) });
    const signals: RankingSignals = {
      ...noSignals,
      affinity: new Map([[String(favourite), 3]]),
    };
    expect(strat.rank([stranger, liked], signals, ctx)[0]).toBe(liked);
  });

  it('does not mutate the input array', () => {
    const a = post();
    const b = post();
    const input = [a, b];
    strat.rank(input, noSignals, ctx);
    expect(input).toEqual([a, b]);
  });

  // ── Reader-feedback dampening (Phase 7d) ─────────────────────────────────
  // A dampening factor is a multiplier in (0,1] applied to a post's score: a
  // down-rank, never an exclusion. Both posts otherwise score identically.

  it('down-ranks a post the viewer marked not-interested (dampenByPost)', () => {
    const damped = post({ createdAt: new Date(NOW) });
    const normal = post({ createdAt: new Date(NOW) });
    const signals: RankingSignals = {
      ...noSignals,
      dampenByPost: new Map([[String(damped._id), 0.4]]),
    };
    const ranked = strat.rank([damped, normal], signals, ctx);
    expect(ranked[0]).toBe(normal);
    // Never excluded — the damped post is still present, just lower.
    expect(ranked).toContain(damped);
    expect(ranked).toHaveLength(2);
  });

  it('down-ranks every post by a derived not-interested author (dampenByAuthor)', () => {
    const author = new Types.ObjectId();
    const damped = post({ authorId: author, createdAt: new Date(NOW) });
    const normal = post({ createdAt: new Date(NOW) });
    const signals: RankingSignals = {
      ...noSignals,
      dampenByAuthor: new Map([[String(author), 0.3]]),
    };
    expect(strat.rank([damped, normal], signals, ctx)[0]).toBe(normal);
  });

  it('down-ranks a post already served in a previous For-You page (seenPostIds)', () => {
    const seen = post({ createdAt: new Date(NOW) });
    const fresh = post({ createdAt: new Date(NOW) });
    const signals: RankingSignals = {
      ...noSignals,
      seenPostIds: new Set([String(seen._id)]),
    };
    const ranked = strat.rank([seen, fresh], signals, ctx);
    expect(ranked[0]).toBe(fresh);
    // Fade, not remove — the seen post is still in the page.
    expect(ranked).toContain(seen);
  });

  // ── Demo/sample down-rank (Demo Content Scope B) ─────────────────────────
  // A seeded demo post (denormalized `isDemo: true`) is down-ranked by a flat
  // multiplier applied LAST — a down-rank, never an exclusion, so it can still
  // surface when nothing else fills the slot.

  it('down-ranks a demo/sample post below an identical real one (isDemo)', () => {
    const demo = post({ isDemo: true, createdAt: new Date(NOW) });
    const real = post({ isDemo: false, createdAt: new Date(NOW) });
    const ranked = strat.rank([demo, real], noSignals, ctx);
    expect(ranked[0]).toBe(real);
    // Fade, not remove — the demo post is still present.
    expect(ranked).toContain(demo);
    expect(ranked).toHaveLength(2);
  });

  it('lets a heavily-engaged seen post still outrank a fresh empty one (resurface)', () => {
    // A viral post the viewer already saw should not be permanently buried — the
    // seen penalty is a multiplier, so a big engagement lead survives it.
    const viralSeen = post({
      createdAt: new Date(NOW),
      reactionCount: 500,
      commentCount: 200,
    });
    const freshEmpty = post({ createdAt: new Date(NOW) });
    const signals: RankingSignals = {
      ...noSignals,
      seenPostIds: new Set([String(viralSeen._id)]),
    };
    expect(strat.rank([freshEmpty, viralSeen], signals, ctx)[0]).toBe(viralSeen);
  });
});
