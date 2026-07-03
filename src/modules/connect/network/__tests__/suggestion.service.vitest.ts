/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing SuggestionService so the transitive
// schema imports (Connection / ConnectionRequest / ConnectProfile /
// WorkspaceMember and their refs) don't trip SchemaFactory reflection. Mirrors
// `network.service.vitest.ts` / `erp-link.service.vitest.ts`.
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
import { SuggestionService } from '../suggestion.service';

/**
 * Unit coverage for `SuggestionService` — the Phase 2 "people you may know"
 * ranking. Verifies the weighted score (skill overlap / mutual connections /
 * shared employment), the exclusion set (self / connected / pending), the
 * zero-signal drop, best-first ordering, and the live-owner guard (orphaned /
 * erased / deactivated profiles never surface as "Connect member" ghost rows).
 * All Models are mocked.
 */

/** A query chain whose every step returns itself; `.exec()` resolves `result`. */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    limit: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

describe('SuggestionService — "people you may know" ranking (Phase 2)', () => {
  const me = new Types.ObjectId();

  let requestModel: any;
  let connectionModel: any;
  let profileModel: any;
  let memberModel: any;
  let workspaceModel: any;
  let userModel: any;
  let partyModel: any;

  function build() {
    return new SuggestionService(
      requestModel,
      connectionModel,
      profileModel,
      memberModel,
      workspaceModel,
      userModel,
      partyModel,
    );
  }

  beforeEach(() => {
    // Defaults — no connections, no pending requests, no profile, no employment.
    requestModel = { find: vi.fn(() => chain([])) };
    connectionModel = { find: vi.fn(() => chain([])) };
    profileModel = { find: vi.fn(() => chain([])), findOne: vi.fn(() => chain(null)) };
    memberModel = { find: vi.fn(() => chain([])) };
    // ERP party-book defaults — viewer owns no workspace, so the signal is inert.
    workspaceModel = { find: vi.fn(() => chain([])) };
    userModel = { find: vi.fn(() => chain([])) };
    partyModel = { find: vi.fn(() => chain([])) };
  });

  it('returns empty when no candidate has any signal (zero-score dropped)', async () => {
    const c1 = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari'] }));
    // One candidate with no overlapping skill, no mutuals, no shared workspace.
    profileModel.find = vi.fn(() => chain([{ userId: c1, skills: ['Welding'] }]));
    // It has a live owning account (so it reaches scoring) — it is dropped for
    // ZERO score here, not by the live-owner guard.
    userModel.find = vi.fn(() => chain([{ _id: c1 }]));

    const result = await build().getSuggestions(me);

    expect(result).toEqual([]);
  });

  it('scores a candidate on skill overlap and reports the shared skills', async () => {
    const c1 = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari', 'Sequins'] }));
    profileModel.find = vi.fn(() => chain([{ userId: c1, skills: ['Zari', 'Aari'] }]));
    userModel.find = vi.fn(() => chain([{ _id: c1 }])); // live owning account

    const result = await build().getSuggestions(me);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(String(c1));
    expect(result[0].sharedSkills).toEqual(['Zari']);
    expect(result[0].score).toBe(3); // 1 shared skill * weight 3
    expect(result[0].mutualConnections).toBe(0);
    expect(result[0].sharedWorkspace).toBe(false);
  });

  it('counts mutual connections shared with a candidate', async () => {
    const c1 = new Types.ObjectId();
    const mutualA = new Types.ObjectId();
    // call 1 — my connections: I am connected to mutualA.
    // call 2 — candidate edges: c1 is also connected to mutualA.
    connectionModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([{ userA: me, userB: mutualA }]))
      .mockReturnValueOnce(chain([{ userA: c1, userB: mutualA }]));
    profileModel.findOne = vi.fn(() => chain({ skills: [] }));
    profileModel.find = vi.fn(() => chain([{ userId: c1, skills: [] }]));
    userModel.find = vi.fn(() => chain([{ _id: c1 }])); // live owning account

    const result = await build().getSuggestions(me);

    expect(result).toHaveLength(1);
    expect(result[0].mutualConnections).toBe(1);
    expect(result[0].score).toBe(2); // 1 mutual * weight 2
  });

  it('scores a shared active employer highest', async () => {
    const c1 = new Types.ObjectId();
    const workspace = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: [] }));
    profileModel.find = vi.fn(() => chain([{ userId: c1, skills: [] }]));
    userModel.find = vi.fn(() => chain([{ _id: c1 }])); // live owning account
    // call 1 — my memberships; call 2 — candidates sharing my workspace.
    memberModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([{ workspaceId: workspace }]))
      .mockReturnValueOnce(chain([{ userId: c1 }]));

    const result = await build().getSuggestions(me);

    expect(result).toHaveLength(1);
    expect(result[0].sharedWorkspace).toBe(true);
    expect(result[0].score).toBe(5); // shared workspace weight
  });

  it('excludes self, existing connections, and pending requests from the candidate query', async () => {
    const connected = new Types.ObjectId();
    const pending = new Types.ObjectId();
    connectionModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([{ userA: me, userB: connected }]))
      .mockReturnValueOnce(chain([]));
    requestModel.find = vi.fn(() => chain([{ fromUserId: me, toUserId: pending }]));
    profileModel.findOne = vi.fn(() => chain({ skills: [] }));

    await build().getSuggestions(me);

    const candidateQuery = profileModel.find.mock.calls[0][0];
    const excluded = (candidateQuery.userId.$nin as Types.ObjectId[]).map((id) => String(id));
    expect(excluded).toContain(String(me));
    expect(excluded).toContain(String(connected));
    expect(excluded).toContain(String(pending));
  });

  it('suggests an ERP party-book contact (matched by phone) with the strongest weight', async () => {
    const supplier = new Types.ObjectId();
    const ws = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: [] }));
    // The supplier is NOT in the base public-profile scan...
    profileModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([])) // base candidate pool — empty
      .mockReturnValueOnce(chain([{ userId: supplier, skills: [] }])); // missing-ERP fetch
    // Viewer owns a workspace whose party book has a phone matching the supplier.
    workspaceModel.find = vi.fn(() => chain([{ _id: ws }]));
    partyModel.find = vi.fn(() => chain([{ phone: '+91 98765 43210', contacts: [] }]));
    userModel.find = vi.fn(() => chain([{ _id: supplier, mobile: '9876543210' }]));

    const result = await build().getSuggestions(me);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(String(supplier));
    expect(result[0].sharedErpParty).toBe(true);
    expect(result[0].score).toBe(6); // WEIGHTS.sharedErpParty
  });

  it('does not match an ERP party whose phone has no Connect user', async () => {
    const ws = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: [] }));
    workspaceModel.find = vi.fn(() => chain([{ _id: ws }]));
    partyModel.find = vi.fn(() => chain([{ phone: '9999900000', contacts: [] }]));
    userModel.find = vi.fn(() => chain([])); // no Connect user with that mobile

    const result = await build().getSuggestions(me);

    expect(result).toEqual([]);
  });

  it('ranks higher-score candidates first and respects the limit', async () => {
    const weak = new Types.ObjectId(); // 1 shared skill -> score 3
    const strong = new Types.ObjectId(); // 2 shared skills -> score 6
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari', 'Aari'] }));
    profileModel.find = vi.fn(() =>
      chain([
        { userId: weak, skills: ['Zari'] },
        { userId: strong, skills: ['Zari', 'Aari'] },
      ]),
    );
    // Both candidates have live owning accounts.
    userModel.find = vi.fn(() => chain([{ _id: weak }, { _id: strong }]));

    const result = await build().getSuggestions(me, 1);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(String(strong));
    expect(result[0].score).toBe(6);
  });

  it('drops a scored candidate whose owning account is not live (no ghost rows)', async () => {
    const orphan = new Types.ObjectId();
    // The candidate shares a skill -> would score 3 and rank. But its owning
    // User is missing / erased / deactivated, so the live-owner guard returns
    // no row for it. It must NOT surface: the web would otherwise render an
    // empty "Connect member" placeholder for an unhydratable id.
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari'] }));
    profileModel.find = vi.fn(() => chain([{ userId: orphan, skills: ['Zari'] }]));
    userModel.find = vi.fn(() => chain([])); // no live owning User for `orphan`

    const result = await build().getSuggestions(me);

    expect(result).toEqual([]);
  });

  it('down-ranks a demo candidate below a real one with the same base score', async () => {
    const realC = new Types.ObjectId(); // real, base score 3
    const demoC = new Types.ObjectId(); // demo, base 3 -> penalized below real
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari'] }));
    profileModel.find = vi.fn(() =>
      chain([
        { userId: realC, skills: ['Zari'] },
        { userId: demoC, skills: ['Zari'] },
      ]),
    );
    // Live-owner guard carries isDemo: demoC is a seeded sample account.
    userModel.find = vi.fn(() => chain([{ _id: realC }, { _id: demoC, isDemo: true }]));

    const result = await build().getSuggestions(me);

    // Both still surface (down-rank, not exclusion) but the real one ranks first
    // and the demo one's score is multiplied by the env penalty (< its base).
    expect(result.map((r) => r.userId)).toEqual([String(realC), String(demoC)]);
    expect(result[0].score).toBe(3);
    expect(result[1].score).toBeLessThan(3);
    expect(result[1].score).toBeGreaterThan(0);
  });

  it('the live-owner guard requires an active, non-deleted, Connect-enabled User', async () => {
    const c1 = new Types.ObjectId();
    profileModel.findOne = vi.fn(() => chain({ skills: ['Zari'] }));
    profileModel.find = vi.fn(() => chain([{ userId: c1, skills: ['Zari'] }]));
    userModel.find = vi.fn(() => chain([{ _id: c1 }]));

    await build().getSuggestions(me);

    // Viewer owns no workspace, so the ERP phone path issues no User query; the
    // sole userModel.find is the live-owner guard. Assert its liveness filter.
    const guardQuery = userModel.find.mock.calls[0][0];
    expect(guardQuery.isActive).toEqual({ $ne: false });
    expect(guardQuery.deletedAt).toEqual({ $in: [null, undefined] });
    expect(guardQuery.connectEnabled).toEqual({ $ne: false });
    expect(String(guardQuery._id.$in[0])).toBe(String(c1));
  });
});
