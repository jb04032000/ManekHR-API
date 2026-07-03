/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports do not trip vitest's reflect-metadata
// pipeline (mirrors the Connect over-limit service test).
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types } from 'mongoose';
import { ErpMemberCapService, ERP_MEMBER_CAP_GRACE_DAYS } from '../erp-member-cap.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── In-memory fakes ──────────────────────────────────────────────────────────

interface FakeMember {
  _id: Types.ObjectId;
  workspaceId: string;
  linkedUserId: string | null;
  dateOfJoining: number | null; // ms epoch or null
  createdAt: number; // ms epoch
}

/** A model over team members. Supports the query shapes the service uses:
 *  countDocuments(filter), findOne(filter).select().lean().exec(),
 *  find(filter).select().sort().lean().exec(). */
function fakeTeamModel(members: FakeMember[]) {
  const activeFilter = (m: FakeMember, filter: Record<string, any>): boolean => {
    if (String(m.workspaceId) !== String(filter.workspaceId)) return false;
    // The service filters active members: isActive:true, isDeleted:false,
    // isPermanentlyDeleted: { $ne: true }. Our fakes are all active, so accept.
    if (filter.linkedUserId !== undefined) {
      const want = filter.linkedUserId;
      if (String(m.linkedUserId ?? '') !== String(want)) return false;
    }
    return true;
  };
  const match = (filter: Record<string, any>) => members.filter((m) => activeFilter(m, filter));
  return {
    countDocuments: (filter: Record<string, any>) => ({
      exec: async () => match(filter).length,
    }),
    findOne: (filter: Record<string, any>) => {
      const builder: any = {
        select: () => builder,
        lean: () => builder,
        exec: async () => match(filter)[0] ?? null,
      };
      return builder;
    },
    find: (filter: Record<string, any>) => {
      let rows = match(filter);
      const builder: any = {
        select: () => builder,
        sort: () => {
          // join date ASC: dateOfJoining then createdAt, oldest first.
          rows = [...rows].sort((a, b) => {
            const aj = a.dateOfJoining ?? a.createdAt;
            const bj = b.dateOfJoining ?? b.createdAt;
            if (aj !== bj) return aj - bj;
            return a.createdAt - b.createdAt;
          });
          return builder;
        },
        lean: () => builder,
        exec: async () => rows.map((r) => ({ _id: r._id })),
      };
      return builder;
    },
  };
}

function fakeWorkspaceModel(workspaceId: string, ownerUserId: string) {
  return {
    findById: (_id: any) => ({
      select: () => ({
        lean: () => ({
          exec: async () =>
            String(_id) === String(workspaceId)
              ? { _id: new Types.ObjectId(workspaceId), ownerId: new Types.ObjectId(ownerUserId) }
              : null,
        }),
      }),
    }),
  };
}

function fakeSubscriptionModel(ownerUserId: string, limit: number | null) {
  return {
    findOne: (_filter: Record<string, any>) => ({
      select: () => ({
        sort: () => ({
          lean: () => ({
            exec: async () =>
              limit === null
                ? null
                : {
                    userId: new Types.ObjectId(ownerUserId),
                    status: 'active',
                    appliedEntitlements: { maxMembersPerWorkspace: limit },
                  },
          }),
        }),
      }),
    }),
  };
}

interface FakeState {
  workspaceId: string;
  overCapSince: Date | null;
  notifiedAt: Date | null;
}

function fakeStateModel(seed: FakeState[] = []) {
  const store = new Map<string, FakeState>();
  for (const s of seed) store.set(String(s.workspaceId), { ...s });
  const matches = (doc: FakeState, filter: Record<string, any>): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'workspaceId') {
        if (String(doc.workspaceId) !== String(v)) return false;
      } else if (k === 'overCapSince') {
        if (v === null) {
          if (doc.overCapSince !== null) return false;
        } else if (v && typeof v === 'object' && v.$ne === null) {
          if (doc.overCapSince === null) return false;
        }
      }
    }
    return true;
  };
  const findDoc = (filter: Record<string, any>): FakeState | null => {
    for (const d of store.values()) if (matches(d, filter)) return d;
    return null;
  };
  return {
    _store: store,
    findOne: (filter: Record<string, any>) => {
      const get = () => findDoc(filter);
      return { lean: () => ({ exec: async () => get() }), exec: async () => get() };
    },
    updateOne: (filter: Record<string, any>, update: Record<string, any>, opts?: any) => ({
      exec: async () => {
        const doc = findDoc(filter);
        if (doc) {
          if (update.$set) Object.assign(doc, update.$set);
          return;
        }
        if (opts?.upsert) {
          const base: FakeState = {
            workspaceId: String(filter.workspaceId),
            overCapSince: null,
            notifiedAt: null,
          };
          if (update.$setOnInsert) Object.assign(base, update.$setOnInsert);
          if (update.$set) Object.assign(base, update.$set);
          store.set(String(base.workspaceId), base);
        }
      },
    }),
  };
}

const WORKSPACE = new Types.ObjectId().toHexString();
const OWNER_USER = new Types.ObjectId().toHexString();

function member(opts: {
  linkedUserId?: string | null;
  dateOfJoining?: number | null;
  createdAt: number;
}): FakeMember {
  return {
    _id: new Types.ObjectId(),
    workspaceId: WORKSPACE,
    linkedUserId: opts.linkedUserId ?? null,
    dateOfJoining: opts.dateOfJoining ?? null,
    createdAt: opts.createdAt,
  };
}

function build(opts: { members: FakeMember[]; limit: number | null; state?: FakeState[] }) {
  const teamModel = fakeTeamModel(opts.members);
  const workspaceModel = fakeWorkspaceModel(WORKSPACE, OWNER_USER);
  const subscriptionModel = fakeSubscriptionModel(OWNER_USER, opts.limit);
  const stateModel = fakeStateModel(opts.state ?? []);
  const notifications = { dispatch: vi.fn().mockResolvedValue({ _id: 'n' }) };
  const service = new ErpMemberCapService(
    teamModel as any,
    workspaceModel as any,
    subscriptionModel as any,
    stateModel as any,
    notifications as any,
  );
  return { service, teamModel, stateModel, notifications };
}

// Build: an owner member (newest join) + N other members (older). Owner is the
// newest so the "owner always present" property is exercised.
function rosterWithOwner(otherCount: number) {
  const others: FakeMember[] = [];
  for (let i = 0; i < otherCount; i++) {
    others.push(member({ createdAt: 1000 + i, dateOfJoining: 1000 + i }));
  }
  const owner = member({
    linkedUserId: OWNER_USER,
    createdAt: 9999,
    dateOfJoining: 9999,
  });
  return { owner, others, all: [...others, owner] };
}

// ── getAllowedMemberIds ──────────────────────────────────────────────────────

describe('ErpMemberCapService.getAllowedMemberIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('limit -1 (UNLIMITED) → all active members (no cap), no state needed', async () => {
    const r = rosterWithOwner(10);
    const f = build({ members: r.all, limit: -1 });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(11); // owner + 10 others
  });

  it('over cap but within grace → all members returned (warning only, no cap)', async () => {
    const r = rosterWithOwner(10); // 11 members, limit 5
    const since = new Date(Date.now() - 1 * MS_PER_DAY); // within 7-day grace
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(11); // not capped yet
  });

  it('over cap with no clock started yet → all members (fair warning first)', async () => {
    const r = rosterWithOwner(10);
    const f = build({ members: r.all, limit: 5, state: [] });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(11);
  });

  it('over cap AFTER grace → owner + oldest (limit-1) others', async () => {
    const r = rosterWithOwner(10); // 11 members, limit 5
    const since = new Date(Date.now() - 8 * MS_PER_DAY); // grace elapsed
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(5);
    // owner present
    expect(allowed).toContain(String(r.owner._id));
    // oldest 4 others present (createdAt 1000..1003)
    const oldest4 = r.others.slice(0, 4).map((m) => String(m._id));
    for (const id of oldest4) expect(allowed).toContain(id);
  });

  it('owner always present in the allowed set even though owner is the NEWEST join', async () => {
    const r = rosterWithOwner(10);
    const since = new Date(Date.now() - 8 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed[0]).toBe(String(r.owner._id)); // owner first
    // the newest 6 others are NOT present (suppressed)
    const newest = r.others.slice(4).map((m) => String(m._id));
    for (const id of newest) expect(allowed).not.toContain(id);
  });

  it('under the limit → everyone (no cap) even with a stale stored clock', async () => {
    const r = rosterWithOwner(3); // 4 members, limit 5
    const since = new Date(Date.now() - 99 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(4);
  });

  it('re-upgrade (limit -> -1) instantly un-caps everyone with no stored-state change', async () => {
    const r = rosterWithOwner(10);
    const since = new Date(Date.now() - 99 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: -1, // upgraded
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(11); // compute-at-read: limit change alone flips it
  });

  it('deleting members shrinks below the limit with no stored-state change', async () => {
    // 11 members but only 4 left after "deletion" (we simulate by passing 4).
    const r = rosterWithOwner(3);
    const since = new Date(Date.now() - 8 * MS_PER_DAY);
    const f = build({
      members: r.all, // 4 active members
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const allowed = await f.service.getAllowedMemberIds(WORKSPACE);
    expect(allowed.length).toBe(4); // under limit → everyone, despite stored clock
  });
});

// ── getCapStatus ─────────────────────────────────────────────────────────────

describe('ErpMemberCapService.getCapStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('capped after grace: visibleCount = limit, totalCount = live count', async () => {
    const r = rosterWithOwner(10);
    const since = new Date(Date.now() - 8 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const status = await f.service.getCapStatus(WORKSPACE, new Date());
    expect(status.capped).toBe(true);
    expect(status.inGrace).toBe(false);
    expect(status.visibleCount).toBe(5);
    expect(status.totalCount).toBe(11);
    expect(status.limit).toBe(5);
    expect(status.graceEndsAt).not.toBeNull();
  });

  it('within grace: not capped, inGrace true, everyone visible', async () => {
    const r = rosterWithOwner(10);
    const since = new Date(Date.now() - 1 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    const status = await f.service.getCapStatus(WORKSPACE, new Date());
    expect(status.capped).toBe(false);
    expect(status.inGrace).toBe(true);
    expect(status.visibleCount).toBe(11);
    expect(status.totalCount).toBe(11);
  });

  it('unlimited: not capped, no grace', async () => {
    const r = rosterWithOwner(10);
    const f = build({ members: r.all, limit: -1 });
    const status = await f.service.getCapStatus(WORKSPACE, new Date());
    expect(status.capped).toBe(false);
    expect(status.inGrace).toBe(false);
    expect(status.limit).toBe(-1);
    expect(status.visibleCount).toBe(11);
    expect(status.totalCount).toBe(11);
  });
});

// ── reconcileWorkspace ───────────────────────────────────────────────────────

describe('ErpMemberCapService.reconcileWorkspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets overCapSince on the first over-cap observation', async () => {
    const r = rosterWithOwner(10); // 11 members, limit 5
    const f = build({ members: r.all, limit: 5, state: [] });
    await f.service.reconcileWorkspace(WORKSPACE, new Date());
    const row = (f.stateModel as any)._store.get(WORKSPACE);
    expect(row).toBeDefined();
    expect(row.overCapSince).not.toBeNull();
  });

  it('notifies exactly once per episode (re-run within the same episode does NOT re-notify)', async () => {
    const r = rosterWithOwner(10);
    // Start already past grace so the notice fires on first reconcile.
    const now = new Date();
    const f = build({ members: r.all, limit: 5, state: [] });

    // First reconcile starts the clock at `now`; grace (7d) has NOT elapsed yet,
    // so the entry notice does NOT fire on the very first observation. Mirror the
    // Connect "fair warning" model: the notice fires once grace has elapsed.
    await f.service.reconcileWorkspace(WORKSPACE, now);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(0);

    // A later reconcile AFTER grace fires the notice exactly once...
    const afterGrace = new Date(now.getTime() + (ERP_MEMBER_CAP_GRACE_DAYS + 1) * MS_PER_DAY);
    await f.service.reconcileWorkspace(WORKSPACE, afterGrace);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);

    // ...and a second reconcile in the SAME episode does not re-notify.
    await f.service.reconcileWorkspace(WORKSPACE, afterGrace);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);

    const arg = f.notifications.dispatch.mock.calls[0][0];
    expect(arg.category).toBe('erp.member_cap');
    expect(String(arg.message)).toContain('Nothing is deleted');
  });

  it('clears overCapSince + notifiedAt when back under cap', async () => {
    const r = rosterWithOwner(3); // 4 members, limit 5 → under cap
    const since = new Date(Date.now() - 8 * MS_PER_DAY);
    const f = build({
      members: r.all,
      limit: 5,
      state: [{ workspaceId: WORKSPACE, overCapSince: since, notifiedAt: since }],
    });
    await f.service.reconcileWorkspace(WORKSPACE, new Date());
    const row = (f.stateModel as any)._store.get(WORKSPACE);
    expect(row.overCapSince).toBeNull();
    expect(row.notifiedAt).toBeNull();
  });
});
