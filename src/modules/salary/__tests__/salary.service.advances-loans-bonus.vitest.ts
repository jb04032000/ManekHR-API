/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Workspace payroll-overview "total outstanding advances" KPI freshness.
 *
 * Bug: SalaryService.getAdvancesLoansBonus summed AdvanceRecoveryPlan.remainingAmount.
 * remainingAmount is initialised to the full totalAmount at plan creation and ONLY
 * recomputed by refreshPlanProgress on plan EDITS (pause/resume/edit/early-payoff) —
 * never on month roll-over / payroll finalize. So a plan that simply runs month to
 * month stays stale-high (often the full totalAmount) and the owner's KPI over-states
 * outstanding advances.
 *
 * Fix: recompute outstanding live at read time, mirroring the worker-facing
 * SalaryService.getOutstandingAdvances and FnfService.getOutstandingAdvances:
 *   outstanding = sum over active|paused plans of (totalAmount - elapsed installments)
 *               + sum of non-plan (legacy lump) advance_recovery deductions whose
 *                 target month is current-or-future.
 * "Elapsed" = target month STRICTLY BEFORE the current payroll month (already recovered).
 *
 * Links: salary.service.ts getAdvancesLoansBonus (~4634), refreshPlanProgress (~2610),
 * getOutstandingAdvances (~7655); fnf.service.ts getOutstandingAdvances (~298) and its
 * sibling spec fnf.service.outstanding-advances.vitest.ts.
 */
import { describe, it, expect, vi } from 'vitest';

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
import { SalaryService } from '../salary.service';

const workspaceId = new Types.ObjectId().toHexString();

// Months relative to "now" so the elapsed/current/future classification matches the
// implementation's own new Date() basis.
const now = new Date();
function shiftMonth(delta: number): { month: number; year: number } {
  const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}
const prev = shiftMonth(-1); // elapsed -> already recovered
const cur = shiftMonth(0); // current -> still outstanding
const next = shiftMonth(1); // future -> still outstanding

function adj(id: Types.ObjectId, period: { month: number; year: number }, amount: number) {
  return { _id: id, month: period.month, year: period.year, amount };
}

/** find().select().lean().exec() -> rows */
function selectLeanExec(rows: any[]) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(rows) }),
    }),
  };
}

/** aggregate([...]).exec() -> rows (mongoose Aggregate is chainable, not a bare promise) */
function aggregateExec(rows: any[]) {
  return { exec: vi.fn().mockResolvedValue(rows) };
}

const noopModel = () => ({
  find: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      exec: vi.fn().mockResolvedValue([]),
    }),
    sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    exec: vi.fn().mockResolvedValue([]),
  }),
  findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
  findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
  countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
  aggregate: vi.fn().mockReturnValue(aggregateExec([])),
});

/**
 * Build a SalaryService with positional mocks. Only the three models the KPI
 * touches need real behaviour: salaryAdjustmentModel (#6), advanceRecoveryPlanModel
 * (#20) and employerLoanModel (#33, kept last in the ctor). paymentModel (#2) and
 * callerScope (#30) are wired so the worker-facing getOutstandingAdvances can run in
 * the cross-method equality test. Everything else is a noop. Trailing ctor args
 * (#34+) are intentionally omitted (undefined) — getAdvancesLoansBonus /
 * getOutstandingAdvances never touch them.
 */
function buildService(opts: {
  plans?: any[];
  recoveryAdjustments?: any[];
  staleRemainingSum?: number; // what the OLD remainingAmount aggregate would have returned
  loanAggregate?: any[];
  bonusAggregate?: any[];
  paymentRows?: any[];
  planById?: any;
  callerScope?: any;
}) {
  const advanceRecoveryPlanModel = {
    ...noopModel(),
    // OLD code path: $sum of remainingAmount. Returned so RED is a clean assertion
    // failure (stale-high) rather than a crash.
    aggregate: vi
      .fn()
      .mockReturnValue(
        aggregateExec(
          opts.staleRemainingSum != null
            ? [{ totalOutstandingAdvances: opts.staleRemainingSum }]
            : [],
        ),
      ),
    // NEW code path: load plans live.
    find: vi.fn().mockReturnValue(selectLeanExec(opts.plans ?? [])),
    // Worker-facing path: plan lookup by id.
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(opts.planById ?? null) }),
  };

  const salaryAdjustmentModel = {
    ...noopModel(),
    find: vi.fn().mockReturnValue(selectLeanExec(opts.recoveryAdjustments ?? [])),
    aggregate: vi.fn().mockReturnValue(aggregateExec(opts.bonusAggregate ?? [])),
  };

  const employerLoanModel = {
    ...noopModel(),
    aggregate: vi.fn().mockReturnValue(aggregateExec(opts.loanAggregate ?? [])),
  };

  const paymentModel = {
    ...noopModel(),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(opts.paymentRows ?? []) }),
    }),
  };

  const callerScope = opts.callerScope ?? {
    resolve: vi.fn(),
    effectiveScope: vi.fn(),
    selfFilterValue: vi.fn(),
  };

  const service = new SalaryService(
    noopModel() as any, // 1 salaryModel
    paymentModel as any, // 2 paymentModel
    noopModel() as any, // 3 teamModel
    noopModel() as any, // 4 attendanceModel
    noopModel() as any, // 5 incrementModel
    salaryAdjustmentModel as any, // 6 salaryAdjustmentModel
    noopModel() as any, // 7 payrollConfigModel
    noopModel() as any, // 8 ptSlabConfigModel
    noopModel() as any, // 9 componentTemplateModel
    noopModel() as any, // 10 workspaceModel
    noopModel() as any, // 11 subscriptionModel
    noopModel() as any, // 12 bulkEmailJobModel
    noopModel() as any, // 13 userModel
    noopModel() as any, // 14 shiftModel
    noopModel() as any, // 15 leaveRequestModel
    noopModel() as any, // 16 leaveTypeModel
    noopModel() as any, // 17 productionLogModel
    noopModel() as any, // 18 machineModel
    noopModel() as any, // 19 pieceRateConfigAuditModel
    advanceRecoveryPlanModel as any, // 20 advanceRecoveryPlanModel
    {} as any, // 21 auditService
    {} as any, // 22 mailService
    {} as any, // 23 payslipPdfService
    {} as any, // 24 complianceExportService
    {} as any, // 25 tdsService
    {} as any, // 26 gratuityService
    {} as any, // 27 fnfService
    {} as any, // 28 attendancePoliciesService
    {} as any, // 29 teamService
    callerScope, // 30 callerScope
    { capture: vi.fn(), identify: vi.fn() } as any, // 31 postHog
    {} as any, // 32 complianceGuard
    employerLoanModel as any, // 33 employerLoanModel (kept LAST)
  );

  return {
    service,
    advanceRecoveryPlanModel,
    salaryAdjustmentModel,
    employerLoanModel,
    paymentModel,
  };
}

const callKpi = (svc: SalaryService) =>
  (svc as any).getAdvancesLoansBonus(workspaceId, cur.month, cur.year) as Promise<{
    totalOutstandingAdvances: number;
    totalActiveLoans: number;
    totalOutstandingLoanPrincipal: number;
    totalBonus: number;
    totalCommission: number;
    totalIncentive: number;
  }>;

describe('SalaryService.getAdvancesLoansBonus — outstanding advances KPI is computed fresh', () => {
  it('ignores stale plan.remainingAmount and sums fresh outstanding across the workspace', async () => {
    const i1 = new Types.ObjectId();
    const i2 = new Types.ObjectId();
    const i3 = new Types.ObjectId();
    const j1 = new Types.ObjectId();
    const j2 = new Types.ObjectId();

    const { service } = buildService({
      // Two members' plans that have simply run month-to-month (never edited), so
      // remainingAmount was never refreshed and still equals the full totalAmount.
      plans: [
        { totalAmount: 30000, remainingAmount: 30000, linkedAdjustmentIds: [i1, i2, i3] },
        { totalAmount: 20000, remainingAmount: 20000, linkedAdjustmentIds: [j1, j2] },
      ],
      recoveryAdjustments: [
        adj(i1, prev, 10000), // elapsed -> recovered
        adj(i2, cur, 10000), // current -> outstanding
        adj(i3, next, 10000), // future -> outstanding
        adj(j1, prev, 10000), // elapsed -> recovered
        adj(j2, cur, 10000), // current -> outstanding
      ],
      // The OLD (buggy) aggregate would have returned the sum of remainingAmount.
      staleRemainingSum: 50000,
    });

    const result = await callKpi(service);

    // Fresh: P1 = 30000 - 10000 = 20000; P2 = 20000 - 10000 = 10000 => 30000.
    // NOT 50000 (the stale remainingAmount sum the old code produced).
    expect(result.totalOutstandingAdvances).toBe(30000);
  });

  it('month-filters legacy lumps and excludes plan-linked ids (no double-count)', async () => {
    const i1 = new Types.ObjectId();
    const i2 = new Types.ObjectId();
    const i3 = new Types.ObjectId();
    const l1 = new Types.ObjectId();
    const l2 = new Types.ObjectId();

    const { service } = buildService({
      plans: [{ totalAmount: 30000, remainingAmount: 30000, linkedAdjustmentIds: [i1, i2, i3] }],
      recoveryAdjustments: [
        adj(i1, prev, 10000), // elapsed plan installment -> recovered
        adj(i2, cur, 10000), // current plan installment -> outstanding
        adj(i3, next, 10000), // future plan installment -> outstanding
        adj(l1, prev, 8000), // legacy lump, elapsed -> already recovered (excluded)
        adj(l2, cur, 5000), // legacy lump, current -> outstanding
      ],
      staleRemainingSum: 30000,
    });

    const result = await callKpi(service);

    // Plan: 30000 - 10000 = 20000. Legacy: l2 only (5000). => 25000.
    expect(result.totalOutstandingAdvances).toBe(25000);
  });

  it('includes a plan un-schedulable residual (totalAmount beyond scheduled installments)', async () => {
    const k1 = new Types.ObjectId();
    const { service } = buildService({
      // 30000 advanced but only one 10000 installment scheduled (compliance-capped);
      // 20000 residual never became an adjustment. None elapsed -> all 30000 outstanding.
      plans: [{ totalAmount: 30000, remainingAmount: 30000, linkedAdjustmentIds: [k1] }],
      recoveryAdjustments: [adj(k1, next, 10000)],
      staleRemainingSum: 30000,
    });

    const result = await callKpi(service);
    expect(result.totalOutstandingAdvances).toBe(30000);
  });

  it('a fully-recovered plan (all installments elapsed) contributes 0', async () => {
    const a1 = new Types.ObjectId();
    const a2 = new Types.ObjectId();
    const twoAgo = shiftMonth(-2);
    const { service } = buildService({
      plans: [{ totalAmount: 20000, remainingAmount: 20000, linkedAdjustmentIds: [a1, a2] }],
      recoveryAdjustments: [adj(a1, twoAgo, 10000), adj(a2, prev, 10000)],
      // Stale remaining would still show 20000 even though it's fully recovered.
      staleRemainingSum: 20000,
    });

    const result = await callKpi(service);
    expect(result.totalOutstandingAdvances).toBe(0);
  });

  it('returns 0 outstanding when the workspace has no plans and no lumps', async () => {
    const { service } = buildService({ plans: [], recoveryAdjustments: [], staleRemainingSum: 0 });
    const result = await callKpi(service);
    expect(result.totalOutstandingAdvances).toBe(0);
  });

  it('passes the loan aggregate through unchanged and keeps the block shape intact', async () => {
    // The advances fix must not disturb the loan / bonus blocks. We assert the loan
    // pass-through (which is correct) and the overall shape. The bonus value mapping
    // has a separate pre-existing defect ($group emits `_id`, the code reads
    // `r.category`) tracked outside this change, so we don't pin bonus values here.
    const { service } = buildService({
      plans: [],
      recoveryAdjustments: [],
      staleRemainingSum: 0,
      loanAggregate: [{ _id: null, count: 3, totalOutstandingPrincipal: 75000 }],
    });

    const result = await callKpi(service);
    expect(result.totalOutstandingAdvances).toBe(0);
    expect(result.totalActiveLoans).toBe(3);
    expect(result.totalOutstandingLoanPrincipal).toBe(75000);
    expect(typeof result.totalBonus).toBe('number');
    expect(typeof result.totalCommission).toBe('number');
    expect(typeof result.totalIncentive).toBe('number');
  });
});

describe('SalaryService.getAdvancesLoansBonus — KPI equals what a worker sees', () => {
  it('workspace KPI matches the worker-facing getOutstandingAdvances for identical data', async () => {
    const planId = new Types.ObjectId();
    const teamMemberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();
    const i1 = new Types.ObjectId();
    const i2 = new Types.ObjectId();
    const i3 = new Types.ObjectId();

    const installments = [adj(i1, prev, 10000), adj(i2, cur, 10000), adj(i3, next, 10000)];

    // Plan that has run month-to-month: remainingAmount stale-high (= totalAmount).
    const plan = {
      _id: planId,
      totalAmount: 30000,
      remainingAmount: 30000,
      status: 'active',
      linkedAdjustmentIds: [i1, i2, i3],
      installments: [
        { index: 1, month: prev.month, year: prev.year, appliedAmount: 10000, status: 'applied' },
        { index: 2, month: cur.month, year: cur.year, appliedAmount: 10000, status: 'scheduled' },
        { index: 3, month: next.month, year: next.year, appliedAmount: 10000, status: 'scheduled' },
      ],
    };

    const callerScope = {
      resolve: vi.fn().mockResolvedValue({ isOwner: true, teamMemberId: null, permissions: [] }),
      effectiveScope: vi.fn().mockReturnValue('all'),
      selfFilterValue: vi.fn(),
    };

    const { service } = buildService({
      plans: [plan],
      recoveryAdjustments: installments,
      staleRemainingSum: 30000,
      planById: plan,
      paymentRows: [
        {
          _id: new Types.ObjectId(),
          advanceRecoveryPlanId: planId,
          advanceRecoveryAdjustmentId: null,
          advanceForMonth: prev.month,
          advanceForYear: prev.year,
          paymentDate: now,
          status: 'completed',
        },
      ],
      callerScope,
    });

    const kpi = await callKpi(service);
    const workerView = await service.getOutstandingAdvances(
      workspaceId,
      teamMemberId.toHexString(),
      userId,
    );

    // The worker sees current + future installments still to be recovered: 20000.
    expect(workerView.outstanding).toBe(20000);
    // The owner's workspace KPI must equal that, not the stale 30000.
    expect(kpi.totalOutstandingAdvances).toBe(workerView.outstanding);
    expect(kpi.totalOutstandingAdvances).toBe(20000);
  });
});
