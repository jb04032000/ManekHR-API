/**
 * Vitest unit tests for SalaryService.calculateMinuteAccurateLop (H3-05).
 *
 * Covers:
 *  - GAP-2.2-C: per-member shift duration (not hardcoded 480) used in LOP math
 *  - GAP-2.2-D: half-day records excluded from supplement (no double-dip)
 *  - Fallback: when member has no shift, 480 min is used
 *
 * Strategy: Mock all NestJS/Mongoose decorator packages so decorators are no-ops,
 * then instantiate the service via Object.create(SalaryService.prototype) and
 * assign only the dependencies the tested method touches. This bypasses the
 * large constructor surface (~14 params) without spinning up a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorator packages before any service import
// ---------------------------------------------------------------------------
vi.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => undefined,
  Prop: () => () => undefined,
  Schema: () => (t: any) => t,
  // Return a CHAINABLE schema stub, not a bare {}. SalaryService transitively
  // imports schemas (e.g. locations/location.schema) that call SchemaFactory-
  // created `Schema.index(...)`/`.pre(...)` at module load; a bare {} makes those
  // top-level calls throw "X is not a function". No-op methods keep the decorator
  // mock side-effect-free (the per-codebase pattern for transitive schema mocks).
  SchemaFactory: {
    createForClass: () => ({
      index: () => undefined,
      pre: () => undefined,
      post: () => undefined,
      set: () => undefined,
      plugin: () => undefined,
      virtual: () => ({ get: () => undefined, set: () => undefined }),
    }),
  },
  MongooseModule: { forFeature: () => ({}) },
}));

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => undefined,
  Inject: () => () => undefined,
  forwardRef: (fn: any) => fn,
  Logger: class {
    log() {}
    warn() {}
    error() {}
    debug() {}
  },
  NotFoundException: class NotFoundException extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'NotFoundException';
    }
  },
  BadRequestException: class BadRequestException extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'BadRequestException';
    }
  },
  ConflictException: class ConflictException extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ConflictException';
    }
  },
  ForbiddenException: class ForbiddenException extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ForbiddenException';
    }
  },
}));

vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: {},
  ScheduleModule: { forRoot: () => ({}) },
}));

// Mock all schema modules referenced in salary.service.ts imports
vi.mock('./schemas/salary.schema', () => ({ Salary: class {}, SalarySchema: {} }));
vi.mock('./schemas/payment.schema', () => ({ Payment: class {}, PaymentSchema: {} }));
vi.mock('./schemas/salary-increment.schema', () => ({
  SalaryIncrement: class {},
  SalaryIncrementSchema: {},
}));
vi.mock('./schemas/salary-adjustment.schema', () => ({
  SalaryAdjustment: class {},
  SalaryAdjustmentSchema: {},
  SALARY_ADDITION_CATEGORIES: [],
  SALARY_DEDUCTION_CATEGORIES: [],
}));
vi.mock('./schemas/payroll-config.schema', () => ({
  PayrollConfig: class {},
  PayrollConfigSchema: {},
}));
vi.mock('./schemas/salary-component-template.schema', () => ({
  SalaryComponentTemplate: class {},
  SalaryComponentTemplateSchema: {},
  SalaryComponentDef: class {},
}));
vi.mock('./schemas/pt-slab.schema', () => ({ PtSlabConfig: class {}, PtSlabConfigSchema: {} }));
vi.mock('./schemas/tax-declaration.schema', () => ({
  TaxDeclaration: class {},
  TaxDeclarationSchema: {},
}));
vi.mock('./schemas/gratuity-ledger.schema', () => ({
  GratuityLedger: class {},
  GratuityLedgerSchema: {},
}));
vi.mock('./schemas/fnf-settlement.schema', () => ({
  FnfSettlement: class {},
  FnfSettlementSchema: {},
}));
vi.mock('./schemas/tds-challan.schema', () => ({ TdsChallan: class {}, TdsChallanSchema: {} }));
vi.mock('./schemas/bulk-email-job.schema', () => ({
  BulkEmailJob: class {},
  BulkEmailJobSchema: {},
}));
vi.mock('../team/schemas/team-member.schema', () => ({
  TeamMember: class {},
  TeamMemberSchema: {},
}));
vi.mock('../users/schemas/user.schema', () => ({ User: class {}, UserSchema: {} }));
vi.mock('../attendance/schemas/attendance.schema', () => ({
  Attendance: class {},
  AttendanceSchema: {},
}));
vi.mock('../workspaces/schemas/workspace.schema', () => ({
  Workspace: class {},
  WorkspaceSchema: {},
}));
vi.mock('../subscriptions/schemas/subscription.schema', () => ({
  Subscription: class {},
  SubscriptionSchema: {},
}));
vi.mock('../shifts/schemas/shift.schema', () => ({ Shift: class {}, ShiftSchema: {} }));
vi.mock('../machines/schemas/machine.schema', () => ({ Machine: class {}, MachineSchema: {} }));
vi.mock('../leave/schemas/leave-request.schema', () => ({
  LeaveRequest: class {},
  LeaveRequestSchema: {},
}));
vi.mock('../leave/schemas/leave-type.schema', () => ({
  LeaveType: class {},
  LeaveTypeSchema: {},
}));
vi.mock('../leave/schemas/leave-balance.schema', () => ({
  LeaveBalance: class {},
  LeaveBalanceSchema: {},
}));
vi.mock('../leave/schemas/encashment-record.schema', () => ({
  EncashmentRecord: class {},
  EncashmentRecordSchema: {},
}));
vi.mock('./utils/component-calculator', () => ({
  calculateComponents: vi.fn(() => ({ total: 0, breakdown: [] })),
}));
vi.mock('./constants/payroll-presets', () => ({ PAYROLL_PRESETS: {} }));
vi.mock('./constants/salary-component-templates', () => ({ BUILT_IN_TEMPLATES: [] }));
vi.mock('./constants/lwf-rates', () => ({
  getLwfRate: vi.fn(() => 0),
  isLwfDeductionMonth: vi.fn(() => false),
}));
vi.mock('../../common/enums/modules.enum', () => ({ AppModule: {} }));

describe('SalaryService.calculateMinuteAccurateLop (H3-05, GAP-2.2-C / GAP-2.2-D)', () => {
  let SalaryServiceClass: any;

  beforeEach(async () => {
    // Dynamic import after vi.mock so all decorators resolve to no-ops
    const mod = await import('./salary.service');
    SalaryServiceClass = mod.SalaryService;
  });

  /**
   * Build a minimal SalaryService instance with only the dependencies that
   * calculateMinuteAccurateLop touches: attendancePoliciesService, teamModel,
   * shiftModel. All other injected fields remain undefined — fine because
   * they are never called in this method path.
   */
  function makeSvc(
    opts: {
      shiftStartTime?: string;
      shiftEndTime?: string;
      hasShift?: boolean;
      lateArrivalCountAsLop?: boolean;
      lopAfterNLateDays?: number | null;
    } = {},
  ) {
    const {
      shiftStartTime = '09:00',
      shiftEndTime = '18:00',
      hasShift = true,
      lateArrivalCountAsLop = true,
      lopAfterNLateDays = null,
    } = opts;

    const policies = {
      findDefault: vi.fn(() => ({
        lateArrival: { countAsLop: lateArrivalCountAsLop, lopAfterNLateDays },
      })),
    };

    const teamModel = {
      findById: (_id: any) => ({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve(hasShift ? { shiftId: 'shift_id_1' } : { shiftId: null }),
          }),
        }),
      }),
    };

    const shiftModel = {
      findById: (_id: any) => ({
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve(
                hasShift ? { startTime: shiftStartTime, endTime: shiftEndTime } : null,
              ),
          }),
        }),
      }),
    };

    // Instantiate via prototype — bypass full constructor injection
    const svc = Object.create(SalaryServiceClass.prototype);
    svc.attendancePoliciesService = policies;
    svc.teamModel = teamModel;
    svc.shiftModel = shiftModel;
    return svc;
  }

  it('per-shift: 10h shift (09:00-19:00), 20 days present, 9h worked each → supplement = 4000', async () => {
    // shiftDuration = 600 min (10h), month=April → workingDays=30
    // totalShiftMinutes = 600 * 30 = 18000
    // lop = (600 - 540) * 20 = 1200 min
    // supplement = 60000 / 18000 * 1200 = 4000
    const svc = makeSvc({ shiftStartTime: '09:00', shiftEndTime: '19:00', hasShift: true });
    const attendance = Array.from({ length: 20 }, () => ({
      status: 'present',
      workedMinutes: 540,
      teamMemberId: 'm1',
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 60000, 'ws1', 4, 2026);
    expect(Math.round(result)).toBe(4000);
  });

  it('half-day records excluded from supplement (GAP-2.2-D) — returns 0', async () => {
    // All 20 records are half_day: eligible set becomes empty → guard fails → 0
    const svc = makeSvc({ shiftStartTime: '09:00', shiftEndTime: '17:00', hasShift: true });
    const attendance = Array.from({ length: 20 }, () => ({
      status: 'half_day',
      workedMinutes: 240,
      teamMemberId: 'm1',
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 48000, 'ws1', 4, 2026);
    // After half-day filter, eligible=0 → recordsWithMinutes(0) < eligible(0)/2 guard fires → 0
    expect(result).toBe(0);
  });

  it('fallback to 480 when member has no shift — supplement uses 8h baseline', async () => {
    // shiftDuration falls back to 480 min (8h), month=April → workingDays=30
    // totalShiftMinutes = 480 * 30 = 14400
    // lop = (480 - 420) * 20 = 1200 min
    // supplement = 48000 / 14400 * 1200 = 4000
    const svc = makeSvc({ hasShift: false });
    const attendance = Array.from({ length: 20 }, () => ({
      status: 'present',
      workedMinutes: 420,
      teamMemberId: 'm1',
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 48000, 'ws1', 4, 2026);
    expect(Math.round(result)).toBe(4000);
  });

  // ── lopAfterNLateDays grace quota (Attendance Completion P1b) ──────────────

  it('lopAfterNLateDays=3 forgives the first 3 late days shortfall → supplement reduced', async () => {
    // 10h shift (600 min), 20 late days, 540 worked each → 60 min shortfall/day → 1200 min lop.
    // Forgive first 3 late days → -180 min → 1020 min → 60000/18000*1020 = 3400.
    const svc = makeSvc({
      shiftStartTime: '09:00',
      shiftEndTime: '19:00',
      hasShift: true,
      lopAfterNLateDays: 3,
    });
    const attendance = Array.from({ length: 20 }, (_, i) => ({
      status: 'late',
      workedMinutes: 540,
      teamMemberId: 'm1',
      date: new Date(Date.UTC(2026, 3, i + 1)),
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 60000, 'ws1', 4, 2026);
    expect(Math.round(result)).toBe(3400);
  });

  it('lopAfterNLateDays=null → no forgiveness, full LOP applies', async () => {
    const svc = makeSvc({
      shiftStartTime: '09:00',
      shiftEndTime: '19:00',
      hasShift: true,
      lopAfterNLateDays: null,
    });
    const attendance = Array.from({ length: 20 }, (_, i) => ({
      status: 'late',
      workedMinutes: 540,
      teamMemberId: 'm1',
      date: new Date(Date.UTC(2026, 3, i + 1)),
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 60000, 'ws1', 4, 2026);
    expect(Math.round(result)).toBe(4000);
  });

  it('lopAfterNLateDays exceeds late-day count → all late shortfall forgiven → 0', async () => {
    const svc = makeSvc({
      shiftStartTime: '09:00',
      shiftEndTime: '19:00',
      hasShift: true,
      lopAfterNLateDays: 50,
    });
    const attendance = Array.from({ length: 20 }, (_, i) => ({
      status: 'late',
      workedMinutes: 540,
      teamMemberId: 'm1',
      date: new Date(Date.UTC(2026, 3, i + 1)),
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 60000, 'ws1', 4, 2026);
    expect(result).toBe(0);
  });

  it('grace quota forgives late days only — present-day shortfall is unaffected', async () => {
    // 20 present days with shortfall + lopAfterNLateDays=3 → no `late` records → nothing forgiven.
    const svc = makeSvc({
      shiftStartTime: '09:00',
      shiftEndTime: '19:00',
      hasShift: true,
      lopAfterNLateDays: 3,
    });
    const attendance = Array.from({ length: 20 }, (_, i) => ({
      status: 'present',
      workedMinutes: 540,
      teamMemberId: 'm1',
      date: new Date(Date.UTC(2026, 3, i + 1)),
    }));
    const result = await svc.calculateMinuteAccurateLop(attendance, 60000, 'ws1', 4, 2026);
    expect(Math.round(result)).toBe(4000);
  });
});
