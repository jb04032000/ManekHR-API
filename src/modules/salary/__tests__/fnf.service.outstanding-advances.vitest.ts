/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FnF outstanding-advance reconciliation (plan §6.8 fast-follow + review fixes).
 *
 * A leaver's Full & Final must net the TRUE, FRESH outstanding advance:
 *   outstanding = sum over active|paused plans of (totalAmount - elapsed installments)
 *               + sum of non-plan (legacy lump) advance_recovery deductions whose
 *                 target month is current-or-future (elapsed lumps are recovered).
 *
 * Why NOT plan.remainingAmount: it is only recomputed by refreshPlanProgress on
 * plan EDITS (pause/resume/edit/early-payoff), never on month roll-over, so it is
 * stale-high between edits — using it would over-charge the leaver. We recompute
 * `totalAmount - sum(elapsed active installments)` live (mirrors refreshPlanProgress)
 * and include any un-schedulable residual. Legacy lumps stay status:'active'
 * forever after recovery, so they MUST be month-filtered or an already-recovered
 * lump is double-deducted.
 *
 * Links: fnf.service.ts getOutstandingAdvances; salary.service.ts refreshPlanProgress
 * (~2610), createAdvanceRecoveryDeduction (legacy lump); advance-recovery-plan.schema.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { FnfService } from '../fnf.service';

const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId().toHexString();

// Months relative to "now" so the elapsed/current/future classification matches
// the implementation's own new Date() basis.
const now = new Date();
function shiftMonth(delta: number): { month: number; year: number } {
  const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}
const prev = shiftMonth(-1); // elapsed (already recovered)
const cur = shiftMonth(0); // current (still outstanding)
const next = shiftMonth(1); // future (still outstanding)

function noopModel() {
  return {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    aggregate: vi.fn().mockResolvedValue([]),
  };
}

function findMock(rows: any[]) {
  return {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  };
}

function buildService(opts: { plans?: any[]; adjustments?: any[] } = {}) {
  const advancePlanModel = findMock(opts.plans ?? []) as any;
  const adjustmentModel = findMock(opts.adjustments ?? []) as any;
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const gratuityService = { computeFnfGratuity: vi.fn() };

  const service = new FnfService(
    noopModel() as any, // 1 fnfModel
    noopModel() as any, // 2 salaryModel
    adjustmentModel, // 3 adjustmentModel
    noopModel() as any, // 4 teamModel
    noopModel() as any, // 5 leaveBalanceModel
    noopModel() as any, // 6 leaveTypeModel
    noopModel() as any, // 7 encashmentModel
    advancePlanModel, // 8 advancePlanModel
    noopModel() as any, // 9 employerLoanModel
    noopModel() as any, // 10 payrollConfigModel
    gratuityService as any, // 11 gratuityService
    auditService as any, // 12 auditService
  );

  return { service, advancePlanModel, adjustmentModel };
}

function adj(id: Types.ObjectId, period: { month: number; year: number }, amount: number) {
  return { _id: id, month: period.month, year: period.year, amount };
}

describe('FnfService.getOutstandingAdvances — fresh, leaver-correct reconciliation', () => {
  const i1 = new Types.ObjectId();
  const i2 = new Types.ObjectId();
  const i3 = new Types.ObjectId();
  const l1 = new Types.ObjectId();
  const l2 = new Types.ObjectId();

  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    ctx = buildService({
      // Plan A: 30000 over 3 monthly installments of 10000. i1 already elapsed.
      plans: [{ totalAmount: 30000, linkedAdjustmentIds: [i1, i2, i3] }],
      adjustments: [
        adj(i1, prev, 10000), // elapsed plan installment -> recovered
        adj(i2, cur, 10000), // current -> outstanding
        adj(i3, next, 10000), // future -> outstanding
        adj(l1, prev, 8000), // legacy lump, elapsed -> already recovered (excluded)
        adj(l2, cur, 5000), // legacy lump, current -> outstanding
      ],
    });
  });

  it('nets elapsed plan installments and future legacy lumps; excludes recovered lumps; no double-count', async () => {
    const total = await (ctx.service as any).getOutstandingAdvances(workspaceId, teamMemberId);
    // Plan A: 30000 - 10000 (i1 elapsed) = 20000.  Legacy: l2 (5000) only.  = 25000.
    expect(total).toBe(25000);
  });

  it('a fully-recovered plan (all installments elapsed) contributes 0', async () => {
    const j1 = new Types.ObjectId();
    const j2 = new Types.ObjectId();
    const twoAgo = shiftMonth(-2);
    const svc = buildService({
      plans: [{ totalAmount: 20000, linkedAdjustmentIds: [j1, j2] }],
      adjustments: [adj(j1, twoAgo, 10000), adj(j2, prev, 10000)],
    });
    const total = await (svc.service as any).getOutstandingAdvances(workspaceId, teamMemberId);
    expect(total).toBe(0);
  });

  it('includes a plan un-schedulable residual (totalAmount > scheduled installments)', async () => {
    const k1 = new Types.ObjectId();
    const svc = buildService({
      // 30000 advanced but only one 10000 installment scheduled (compliance-capped);
      // 20000 residual never became an adjustment. None elapsed -> all 30000 outstanding.
      plans: [{ totalAmount: 30000, linkedAdjustmentIds: [k1] }],
      adjustments: [adj(k1, next, 10000)],
    });
    const total = await (svc.service as any).getOutstandingAdvances(workspaceId, teamMemberId);
    expect(total).toBe(30000);
  });

  it('returns 0 when there are no plans and no adjustments', async () => {
    const svc = buildService({ plans: [], adjustments: [] });
    const total = await (svc.service as any).getOutstandingAdvances(workspaceId, teamMemberId);
    expect(total).toBe(0);
  });
});
