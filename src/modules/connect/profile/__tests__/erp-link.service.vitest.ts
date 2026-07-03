/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing ErpLinkService so the transitive
// schema imports (Attendance, Salary, SaleInvoice, ExpenseVoucher and their
// own transitive refs) don't trip SchemaFactory's "Cannot determine a type"
// reflection error. ErpLinkService never touches Mongoose directly — every
// Model is injected here as a plain mock. Mirrors the worked example in
// `auth/__tests__/auth.service.audit.vitest.ts`.
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
import {
  ErpLinkService,
  ERP_LINK_ACTIVITY_WINDOW_DAYS,
  ERP_LINK_DECAY_DAYS,
} from '../erp-link.service';

/**
 * Unit coverage for ErpLinkService — the design-decisions doc §9.1 "ERP-linked"
 * moat derivation.
 *
 * Verifies:
 *   - Each of the 3 signal paths independently earns the badge:
 *       attendance ≥ 5, payroll runs ≥ 1, invoices/expenses ≥ 3.
 *   - The 60-day decay: a workspace silent ≥ 60 days is not linked and the
 *     per-signal window queries are short-circuited.
 *   - The not-linked case: a workspace below every threshold.
 *   - `since` reflects the earliest ERP activity; `null` when there is none.
 *   - A DB error degrades to not-linked rather than throwing (trust badge
 *     must never break the profile).
 *
 * All four ERP Models are mocked — no MongoDB.
 */

// ── Mongo query-builder mock helpers ──────────────────────────────────────
// findOne(...).select(...).sort(...).lean(...).exec()
function buildFindOneChain(doc: { createdAt?: Date } | null) {
  const chain: any = {
    select: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(doc),
  };
  return chain;
}

/**
 * Build the four-model mock set. Each entry lets a test dictate:
 *   - count:        countDocuments() result
 *   - aggregateRows: aggregate() result rows (payroll-run groups)
 *   - first/last:   the createdAt of the asc / desc findOne probe
 */
interface ModelSpec {
  count?: number;
  aggregateRows?: Array<{ _id: { month: number; year: number } }>;
  firstActivity?: Date | null;
  lastActivity?: Date | null;
}

function makeModel(spec: ModelSpec) {
  const first = spec.firstActivity ?? null;
  const last = spec.lastActivity ?? null;
  return {
    countDocuments: vi.fn(() => ({
      exec: vi.fn().mockResolvedValue(spec.count ?? 0),
    })),
    aggregate: vi.fn(() => ({
      exec: vi.fn().mockResolvedValue(spec.aggregateRows ?? []),
    })),
    // findOne is called twice per collection (asc probe, then desc probe).
    // Return the asc doc on the 1st call and the desc doc on the 2nd.
    findOne: (() => {
      let call = 0;
      return vi.fn(() => {
        call += 1;
        const doc = call === 1 ? first : last;
        return buildFindOneChain(doc === null ? null : { createdAt: doc });
      });
    })(),
  };
}

/**
 * Build a mock `Model<WorkspaceMember>` for `getUserStatus`. The service calls
 * `find(...).select('workspaceId').lean().exec()` to resolve the user's active
 * employment — this stub resolves it to `rows`.
 */
function makeMemberModel(rows: Array<{ workspaceId: Types.ObjectId }>) {
  const chain: any = {
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(rows),
  };
  return { find: vi.fn(() => chain) };
}

/**
 * Build a mock `Model<ConnectProfile>` for the consent gate (ADR-0004).
 * `getUserStatus` reads `findOne(...).select('erpVerificationConsent').lean().exec()`.
 * Pass the consent status the profile should report ('granted' | 'revoked' |
 * undefined = never consented).
 */
function makeProfileModel(consentStatus?: 'granted' | 'revoked') {
  const doc =
    consentStatus === undefined ? {} : { erpVerificationConsent: { status: consentStatus } };
  const chain: any = {
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(doc),
  };
  return { findOne: vi.fn(() => chain) };
}

describe('ErpLinkService — ERP-linked moat derivation (§9.1)', () => {
  const workspaceId = new Types.ObjectId();
  // Fixed clock so window maths is deterministic.
  const now = new Date('2026-05-18T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  // Activity dates safely inside / outside the windows.
  const recent = daysAgo(3); // within the 30-day activity window
  const oldButLive = daysAgo(45); // outside 30-day window, inside 60-day
  const decayed = daysAgo(90); // outside the 60-day decay window

  let attendance: any;
  let salary: any;
  let saleInvoice: any;
  let expense: any;
  let workspaceMember: any;

  function buildService() {
    // 6th arg — the Workspace model, used only by `getErpSummary`, which these
    // suites do not exercise; a bare stub keeps the constructor satisfied. 7th —
    // the ConnectProfile model for the consent gate (ADR-0004); these
    // getWorkspaceStatus tests call the ungated path, so a granted stub suffices.
    return new ErpLinkService(
      attendance,
      salary,
      saleInvoice,
      expense,
      workspaceMember,
      {} as any,
      makeProfileModel('granted') as any,
    );
  }

  beforeEach(() => {
    // Default: every collection empty / no activity. Tests override per-signal.
    attendance = makeModel({});
    salary = makeModel({});
    saleInvoice = makeModel({});
    expense = makeModel({});
    // Default: the user has no active employment. `getUserStatus` tests
    // override this; `getWorkspaceStatus` tests never touch it.
    workspaceMember = makeMemberModel([]);
  });

  it('exposes the design-doc §9.1 window constants', () => {
    expect(ERP_LINK_ACTIVITY_WINDOW_DAYS).toBe(30);
    expect(ERP_LINK_DECAY_DAYS).toBe(60);
  });

  // ── Signal 1 — attendance ≥ 5 ──────────────────────────────────────────
  it('links a workspace with ≥ 5 attendance entries in the window', async () => {
    attendance = makeModel({
      count: 5,
      firstActivity: daysAgo(200),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(true);
    expect(result.signals.attendance).toBe(5);
    expect(result.signals.payrollRuns).toBe(0);
    expect(result.signals.invoices).toBe(0);
    // `since` = earliest activity across all collections.
    expect(result.since).toEqual(daysAgo(200));
  });

  it('does NOT link on only 4 attendance entries (below threshold)', async () => {
    attendance = makeModel({
      count: 4,
      firstActivity: daysAgo(50),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(false);
    expect(result.signals.attendance).toBe(4);
  });

  // ── Signal 2 — ≥ 1 payroll run ─────────────────────────────────────────
  it('links a workspace with ≥ 1 payroll run in the window', async () => {
    // One distinct (month, year) group = one payroll run.
    salary = makeModel({
      aggregateRows: [{ _id: { month: 4, year: 2026 } }],
      firstActivity: daysAgo(120),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(true);
    expect(result.signals.payrollRuns).toBe(1);
    expect(result.signals.attendance).toBe(0);
    expect(result.signals.invoices).toBe(0);
  });

  it('counts distinct (month, year) groups as separate payroll runs', async () => {
    salary = makeModel({
      aggregateRows: [{ _id: { month: 3, year: 2026 } }, { _id: { month: 4, year: 2026 } }],
      firstActivity: daysAgo(120),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.signals.payrollRuns).toBe(2);
    expect(result.linked).toBe(true);
  });

  // ── Signal 3 — invoices + expenses ≥ 3 ─────────────────────────────────
  it('links a workspace with ≥ 3 invoices/expenses (summed across both collections)', async () => {
    saleInvoice = makeModel({
      count: 2,
      firstActivity: daysAgo(80),
      lastActivity: recent,
    });
    expense = makeModel({
      count: 1,
      firstActivity: daysAgo(70),
      lastActivity: daysAgo(5),
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    // 2 sale invoices + 1 expense voucher = 3 → threshold met.
    expect(result.signals.invoices).toBe(3);
    expect(result.linked).toBe(true);
    // `since` is the earliest across BOTH finance collections.
    expect(result.since).toEqual(daysAgo(80));
    // Moat-signal integrity (§9.1 "real operational data"): only `posted`
    // vouchers count — a positive allow-list, never a $nin blocklist. This
    // excludes `draft` AND `pending_approval` invoices, and the sale-invoice
    // query is pinned to `voucherType: 'sale_invoice'` + non-deleted.
    expect(saleInvoice.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'posted',
        voucherType: 'sale_invoice',
        isDeleted: { $ne: true },
      }),
    );
    expect(expense.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'posted' }),
    );
  });

  it('does NOT link on only 2 invoices/expenses combined', async () => {
    saleInvoice = makeModel({
      count: 1,
      firstActivity: daysAgo(40),
      lastActivity: recent,
    });
    expense = makeModel({
      count: 1,
      firstActivity: daysAgo(35),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.signals.invoices).toBe(2);
    expect(result.linked).toBe(false);
  });

  // ── 60-day decay ───────────────────────────────────────────────────────
  it('does NOT link a workspace whose last activity is older than 60 days (decayed)', async () => {
    // Plenty of historical activity, but the most recent is 90 days ago.
    attendance = makeModel({
      count: 999, // would be way over threshold IF it were in-window
      firstActivity: daysAgo(400),
      lastActivity: decayed,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(false);
    // Decay short-circuit zeroes the signals — the per-window count queries
    // are never even issued.
    expect(result.signals).toEqual({
      attendance: 0,
      payrollRuns: 0,
      invoices: 0,
    });
    expect(attendance.countDocuments).not.toHaveBeenCalled();
    // `since` is still surfaced — a decayed workspace WAS active once.
    expect(result.since).toEqual(daysAgo(400));
  });

  it('still evaluates a workspace active within 60 days but outside the 30-day window', async () => {
    // Last activity 45 days ago: past the decay cutoff so NOT short-circuited,
    // but outside the 30-day activity window so every in-window count is 0.
    attendance = makeModel({
      count: 0,
      firstActivity: daysAgo(120),
      lastActivity: oldButLive,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(false);
    // Not short-circuited — the count query WAS issued.
    expect(attendance.countDocuments).toHaveBeenCalled();
    expect(result.signals.attendance).toBe(0);
  });

  // ── Not-linked baseline ────────────────────────────────────────────────
  it('does NOT link a workspace with no ERP activity at all', async () => {
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result.linked).toBe(false);
    expect(result.since).toBeNull();
    expect(result.signals).toEqual({
      attendance: 0,
      payrollRuns: 0,
      invoices: 0,
    });
  });

  it('does NOT link a workspace active in-window but below every threshold', async () => {
    attendance = makeModel({
      count: 4,
      firstActivity: daysAgo(20),
      lastActivity: recent,
    });
    salary = makeModel({
      aggregateRows: [],
      firstActivity: daysAgo(20),
      lastActivity: recent,
    });
    saleInvoice = makeModel({
      count: 1,
      firstActivity: daysAgo(20),
      lastActivity: recent,
    });
    expense = makeModel({
      count: 1,
      firstActivity: daysAgo(20),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId, now);

    // 4 attendance (< 5), 0 payroll runs (< 1), 2 invoices (< 3) → not linked.
    expect(result.linked).toBe(false);
    expect(result.signals).toEqual({
      attendance: 4,
      payrollRuns: 0,
      invoices: 2,
    });
  });

  // ── Graceful degradation ───────────────────────────────────────────────
  it('degrades to not-linked (no throw) when a DB query fails', async () => {
    // First probe (findActivityBoundary asc) blows up.
    attendance = {
      countDocuments: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(0) })),
      aggregate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue([]) })),
      findOne: vi.fn(() => {
        throw new Error('mongo connection lost');
      }),
    };
    const svc = buildService();

    // Must resolve, not reject — a trust badge can't break the profile.
    const result = await svc.getWorkspaceStatus(workspaceId, now);

    expect(result).toEqual({
      linked: false,
      since: null,
      signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
    });
  });

  it('accepts a string workspaceId (coerces to ObjectId)', async () => {
    attendance = makeModel({
      count: 6,
      firstActivity: daysAgo(10),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getWorkspaceStatus(workspaceId.toHexString(), now);

    expect(result.linked).toBe(true);
    expect(result.signals.attendance).toBe(6);
  });
});

/**
 * Unit coverage for `ErpLinkService.getUserStatus` — the employment-derived
 * ERP-linked verdict (post-reframe: Connect is standalone, so the moat signal
 * comes from a user's active `WorkspaceMember` rows, never a field on the
 * `ConnectProfile`).
 *
 * Verifies the documented combine rule:
 *   - no active employment        → the unlinked default;
 *   - one active linked workspace → linked, with that workspace's verdict;
 *   - multiple linked workspaces  → `signals` summed across the linked ones;
 *   - an employer below threshold → not linked;
 *   - a DB error                 → degrades to unlinked (no throw).
 *
 * The `WorkspaceMember` model + the four ERP collections are all mocked — no
 * MongoDB. `getUserStatus` delegates each per-workspace verdict to
 * `getWorkspaceStatus`, which reads the shared ERP-collection mocks.
 */
describe('ErpLinkService.getUserStatus — employment-derived ERP-linked verdict', () => {
  const userId = new Types.ObjectId();
  const now = new Date('2026-05-18T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
  const recent = daysAgo(3);

  let attendance: any;
  let salary: any;
  let saleInvoice: any;
  let expense: any;
  let workspaceMember: any;
  let connectProfile: any;

  function buildService() {
    // 6th arg — the Workspace model (getErpSummary only, unused here). 7th — the
    // ConnectProfile model, which now drives the ADR-0004 consent gate.
    return new ErpLinkService(
      attendance,
      salary,
      saleInvoice,
      expense,
      workspaceMember,
      {} as any,
      connectProfile,
    );
  }

  beforeEach(() => {
    attendance = makeModel({});
    salary = makeModel({});
    saleInvoice = makeModel({});
    expense = makeModel({});
    workspaceMember = makeMemberModel([]);
    // Default: consent GRANTED so the existing employment-derivation assertions
    // exercise the post-gate path. The gate tests below override this.
    connectProfile = makeProfileModel('granted');
  });

  // ── Consent gate (ADR-0004 / 2026-06-18 spec) ────────────────────────────
  it('returns the unlinked default when the user has NOT consented (no consent record)', async () => {
    connectProfile = makeProfileModel(undefined); // never asked
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({ count: 999, firstActivity: daysAgo(100), lastActivity: recent });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result).toEqual({
      linked: false,
      since: null,
      signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
    });
    // Gate short-circuits BEFORE any employment / ERP-activity query.
    expect(workspaceMember.find).not.toHaveBeenCalled();
    expect(attendance.findOne).not.toHaveBeenCalled();
  });

  it('returns the unlinked default when the user REVOKED consent', async () => {
    connectProfile = makeProfileModel('revoked');
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({ count: 999, firstActivity: daysAgo(100), lastActivity: recent });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result.linked).toBe(false);
    expect(workspaceMember.find).not.toHaveBeenCalled();
  });

  it('links a consented user with over-threshold employment ERP activity', async () => {
    connectProfile = makeProfileModel('granted');
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({ count: 6, firstActivity: daysAgo(150), lastActivity: recent });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result.linked).toBe(true);
    expect(result.signals.attendance).toBe(6);
  });

  it('returns the unlinked default when the user has no active employment', async () => {
    // Even with abundant ERP activity, a user employed nowhere is not linked.
    attendance = makeModel({ count: 999, firstActivity: daysAgo(100), lastActivity: recent });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result).toEqual({
      linked: false,
      since: null,
      signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
    });
    // No employment → the per-workspace derivation is never invoked.
    expect(attendance.findOne).not.toHaveBeenCalled();
  });

  it('links a user with one active workspace whose ERP activity is over threshold', async () => {
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({
      count: 6, // ≥ 5 → workspace is ERP-linked
      firstActivity: daysAgo(150),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result.linked).toBe(true);
    expect(result.signals.attendance).toBe(6);
    // `since` = the linked workspace's earliest ERP activity.
    expect(result.since).toEqual(daysAgo(150));
    // Employment was resolved on `{ userId, status: 'active' }`.
    expect(workspaceMember.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('does NOT link a user whose only employer is below every threshold', async () => {
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({
      count: 4, // < 5 → workspace not linked
      firstActivity: daysAgo(20),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result.linked).toBe(false);
    // `since` is surfaced only for LINKED workspaces — none here.
    expect(result.since).toBeNull();
    // Signals fold over linked workspaces only → all zero.
    expect(result.signals).toEqual({ attendance: 0, payrollRuns: 0, invoices: 0 });
  });

  it('sums signals across multiple linked workspaces (combine rule: sum)', async () => {
    // Two active employers. Both resolve through the shared ERP-collection
    // mocks, so each per-workspace verdict is identical (attendance = 6,
    // linked). The combine rule SUMS the signals of the linked workspaces.
    workspaceMember = makeMemberModel([
      { workspaceId: new Types.ObjectId() },
      { workspaceId: new Types.ObjectId() },
    ]);
    attendance = makeModel({
      count: 6,
      firstActivity: daysAgo(80),
      lastActivity: recent,
    });
    const svc = buildService();

    const result = await svc.getUserStatus(userId, now);

    expect(result.linked).toBe(true);
    // 6 + 6 across the two linked workspaces.
    expect(result.signals.attendance).toBe(12);
    // `since` = earliest non-null among the linked workspaces.
    expect(result.since).toEqual(daysAgo(80));
  });

  it('degrades to the unlinked default (no throw) when the membership query fails', async () => {
    workspaceMember = {
      find: vi.fn(() => {
        throw new Error('mongo connection lost');
      }),
    };
    const svc = buildService();

    // Must resolve, not reject — the ERP-linked badge can't break the profile.
    const result = await svc.getUserStatus(userId, now);

    expect(result).toEqual({
      linked: false,
      since: null,
      signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
    });
  });

  it('accepts a string userId (coerces to ObjectId)', async () => {
    workspaceMember = makeMemberModel([{ workspaceId: new Types.ObjectId() }]);
    attendance = makeModel({ count: 6, firstActivity: daysAgo(40), lastActivity: recent });
    const svc = buildService();

    const result = await svc.getUserStatus(userId.toHexString(), now);

    expect(result.linked).toBe(true);
  });
});
