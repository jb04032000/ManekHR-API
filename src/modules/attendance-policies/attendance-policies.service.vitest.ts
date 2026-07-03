/**
 * Vitest unit tests for AttendancePoliciesService.findEffective() and findDefault().
 *
 * Strategy: Mock all NestJS/Mongoose decorator packages so @Prop / @Schema /
 * @Injectable decorators are no-ops during test collection, then directly
 * instantiate the service with plain vi.fn() mock objects.
 *
 * Covers: D-17, D-18, D-19, D-20 (scope resolution) and T-H2-04-01 (workspace isolation).
 * Closes: TEST-03
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorator packages before any service import so
// @Prop / @Schema / @Injectable / @Inject / forwardRef decorators are no-ops.
// ---------------------------------------------------------------------------
vi.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: { createForClass: () => ({}) },
  MongooseModule: { forFeature: () => ({}) },
}));

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => {},
  Inject: () => () => {},
  forwardRef: (fn: any) => fn,
  Logger: class {
    log() {}
    warn() {}
    error() {}
    debug() {}
  },
  NotFoundException: class NotFoundException extends Error {
    constructor(msg: string) { super(msg); this.name = 'NotFoundException'; }
  },
  BadRequestException: class BadRequestException extends Error {
    constructor(msg: string) { super(msg); this.name = 'BadRequestException'; }
  },
}));

// Mock schema files to plain objects — prevents Mongoose decorator errors
vi.mock('./schemas/attendance-policy.schema', () => ({
  AttendancePolicy: class {},
  AttendancePolicySchema: {},
}));

vi.mock('../attendance/schemas/attendance.schema', () => ({
  Attendance: class {},
  AttendanceSchema: {},
}));

vi.mock('../attendance/attendance-event.service', () => ({
  AttendanceEventService: class {
    findByMemberDateRange = vi.fn().mockResolvedValue([]);
  },
}));

// Mock the compute module — pure functions, not needed for findEffective tests
vi.mock('../attendance/projection/compute', () => ({
  computeDailySummary: vi.fn(),
  DEFAULT_SHIFT_SNAPSHOT: {},
  DEFAULT_POLICY_SNAPSHOT: {},
}));

// Mock DTOs — only used by create/update methods, not findEffective
vi.mock('./dto/attendance-policy.dto', () => ({
  CreateAttendancePolicyDto: class {},
  UpdateAttendancePolicyDto: class {},
  DryRunDto: class {},
}));

// Now import the service — all decorators are no-ops
import { AttendancePoliciesService } from './attendance-policies.service';

// ---------------------------------------------------------------------------
// Build a query-chain mock that mirrors .findOne(filter).lean().exec() → result
// ---------------------------------------------------------------------------
type QueryChain<T> = { lean: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };
const makeQuery = <T>(result: T): QueryChain<T> => ({
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(result),
});

// Fixture builders — plain objects matching AttendancePolicy schema shape
const mkPolicy = (overrides: Partial<Record<string, any>> = {}) => ({
  _id: new Types.ObjectId(),
  name: 'TestPolicy',
  isDefault: false,
  wsId: new Types.ObjectId(),
  lateArrival: { countAsLop: false, lopAfterNLateDays: null },
  earlyDeparture: { enabled: false, thresholdMinutes: 30, countAsHalfDay: false },
  ot: { enabled: false, thresholdMinutes: 30, capMinutes: null },
  compOff: { enabled: false },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('AttendancePoliciesService — scope resolution (TEST-03)', () => {
  const WS_A = '507f1f77bcf86cd799439011';
  const WS_B = '507f1f77bcf86cd799439012';
  const POLICY_ID = '507f1f77bcf86cd799439021';

  let policyModel: { findOne: ReturnType<typeof vi.fn> };
  let attendanceModel: { find: ReturnType<typeof vi.fn> };
  let eventService: { findByMemberDateRange: ReturnType<typeof vi.fn> };
  let service: AttendancePoliciesService;

  beforeEach(() => {
    policyModel     = { findOne: vi.fn() };
    attendanceModel = { find: vi.fn() };
    eventService    = { findByMemberDateRange: vi.fn() };
    service = new AttendancePoliciesService(
      policyModel     as any,
      attendanceModel as any,
      eventService    as any,
    );
  });

  describe('findEffective — scope resolution', () => {
    it('D-17: returns the policy when shift has a valid policyId in the same workspace', async () => {
      const requested = mkPolicy({ name: 'SpecificPolicy', _id: new Types.ObjectId(POLICY_ID) });
      policyModel.findOne.mockReturnValueOnce(makeQuery(requested));

      const result = await service.findEffective(WS_A, POLICY_ID);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('SpecificPolicy');
      expect(policyModel.findOne).toHaveBeenCalledTimes(1);
      expect(policyModel.findOne).toHaveBeenCalledWith({
        _id: expect.any(Types.ObjectId),
        wsId: expect.any(Types.ObjectId),
      });
    });

    it('D-18: falls back to workspace default when policyId is null', async () => {
      const def = mkPolicy({ name: 'WorkspaceDefault', isDefault: true });
      policyModel.findOne.mockReturnValueOnce(makeQuery(def));

      const result = await service.findEffective(WS_A, null);

      expect(result).not.toBeNull();
      expect(result!.isDefault).toBe(true);
      expect(policyModel.findOne).toHaveBeenCalledTimes(1);
      expect(policyModel.findOne).toHaveBeenCalledWith({
        wsId: expect.any(Types.ObjectId),
        isDefault: true,
      });
    });

    it('D-19: returns null when policyId is null AND no default exists (no throw)', async () => {
      policyModel.findOne.mockReturnValueOnce(makeQuery(null));

      const result = await service.findEffective(WS_A, null);

      expect(result).toBeNull();
      expect(policyModel.findOne).toHaveBeenCalledTimes(1);
    });

    it('D-20: falls back to default when policyId belongs to a different workspace', async () => {
      // First lookup (cross-workspace) misses — wsA filter returns null for WS_B policy
      policyModel.findOne.mockReturnValueOnce(makeQuery(null));
      // Second lookup (default) returns workspace default
      const def = mkPolicy({ name: 'DefaultForWsA', isDefault: true });
      policyModel.findOne.mockReturnValueOnce(makeQuery(def));

      const result = await service.findEffective(WS_A, POLICY_ID);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('DefaultForWsA');
      expect(policyModel.findOne).toHaveBeenCalledTimes(2);
    });

    it('D-20 variant: returns default when policyId does not exist in any workspace', async () => {
      policyModel.findOne
        .mockReturnValueOnce(makeQuery(null))
        .mockReturnValueOnce(makeQuery(mkPolicy({ isDefault: true })));

      const result = await service.findEffective(WS_A, POLICY_ID);
      expect(result!.isDefault).toBe(true);
    });
  });

  describe('findEffective — falsy policyId handling', () => {
    it('undefined policyId behaves like null → calls findDefault only', async () => {
      policyModel.findOne.mockReturnValueOnce(makeQuery(mkPolicy({ isDefault: true })));
      await service.findEffective(WS_A, undefined);
      expect(policyModel.findOne).toHaveBeenCalledTimes(1);
      expect(policyModel.findOne).toHaveBeenCalledWith({
        wsId: expect.any(Types.ObjectId),
        isDefault: true,
      });
    });

    it('empty string policyId behaves like null → calls findDefault only', async () => {
      policyModel.findOne.mockReturnValueOnce(makeQuery(mkPolicy({ isDefault: true })));
      await service.findEffective(WS_A, '');
      expect(policyModel.findOne).toHaveBeenCalledTimes(1);
      expect(policyModel.findOne).toHaveBeenCalledWith({
        wsId: expect.any(Types.ObjectId),
        isDefault: true,
      });
    });
  });

  describe('findDefault', () => {
    it('returns the default policy for the workspace', async () => {
      policyModel.findOne.mockReturnValueOnce(makeQuery(mkPolicy({ isDefault: true })));
      const result = await service.findDefault(WS_A);
      expect(result!.isDefault).toBe(true);
      expect(policyModel.findOne).toHaveBeenCalledWith({
        wsId: expect.any(Types.ObjectId),
        isDefault: true,
      });
    });

    it('returns null when no default exists', async () => {
      policyModel.findOne.mockReturnValueOnce(makeQuery(null));
      const result = await service.findDefault(WS_A);
      expect(result).toBeNull();
    });
  });

  describe('findEffective — workspace isolation (security boundary)', () => {
    it('T-H2-04-01: never returns a policy from a different workspace', async () => {
      // Scenario: attacker-like input — policyId belongs to WS_B but request is scoped to WS_A
      policyModel.findOne
        .mockReturnValueOnce(makeQuery(null))                                      // first lookup filtered by wsA → miss
        .mockReturnValueOnce(makeQuery(mkPolicy({ name: 'wsA-default', isDefault: true })));

      const result = await service.findEffective(WS_A, POLICY_ID);

      // Every findOne call MUST include the requesting workspace id in the filter.
      // We reconstruct Types.ObjectId(WS_A) and verify the wsId arg matches (via .equals()).
      const calls = policyModel.findOne.mock.calls;
      expect(calls.length).toBe(2);
      for (const [filter] of calls) {
        expect(filter.wsId).toBeDefined();
        // Mongoose ObjectIds support .equals() — assert the wsId is WS_A, never WS_B.
        expect((filter.wsId as Types.ObjectId).equals(new Types.ObjectId(WS_A))).toBe(true);
      }
      expect(result!.name).toBe('wsA-default');
    });
  });
});
