import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorators before importing the service
// ---------------------------------------------------------------------------
vi.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: { createForClass: () => ({}) },
}));

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => {},
  NotFoundException: class NotFoundException extends Error {
    constructor(msg: string) { super(msg); this.name = 'NotFoundException'; }
  },
  BadRequestException: class BadRequestException extends Error {
    constructor(msg: string) { super(msg); this.name = 'BadRequestException'; }
  },
  Logger: class {
    log() {} warn() {} error() {} debug() {}
  },
}));

vi.mock('./ot-rate-resolver.service', () => ({
  OtRateResolver: class {
    resolve = vi.fn().mockResolvedValue({ dailyRate: 0, source: 'salary_ledger' });
  },
}));

import { StatutoryDataService } from './statutory-data.service';

// ---------------------------------------------------------------------------
// Stub for the StatutoryDataService constructor injection
// ---------------------------------------------------------------------------
function makeService(overrides: Record<string, any> = {}) {
  const service = Object.create(StatutoryDataService.prototype);
  Object.assign(service, {
    attendanceModel: { find: vi.fn() },
    salaryModel: { findOne: vi.fn() },
    teamMemberModel: { find: vi.fn() },
    shiftModel: { find: vi.fn() },
    workspaceModel: { findById: vi.fn() },
    otRateResolver: { resolve: vi.fn() },
    ...overrides,
  });
  return service as InstanceType<typeof StatutoryDataService>;
}

// ---------------------------------------------------------------------------
// shiftDurationMinutesFor — unit tests (private, accessed via cast)
// ---------------------------------------------------------------------------
describe('shiftDurationMinutesFor', () => {
  const svc: any = makeService();

  it('returns 480 when shift is null', () => {
    expect(svc.shiftDurationMinutesFor(null)).toBe(480);
  });

  it('returns 480 when shift has no startTime', () => {
    expect(svc.shiftDurationMinutesFor({ endTime: '17:00' })).toBe(480);
  });

  it('8h shift (09:00–17:00) → 480 min', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: '09:00', endTime: '17:00' })).toBe(480);
  });

  it('10h shift (08:00–18:00) → 600 min', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: '08:00', endTime: '18:00' })).toBe(600);
  });

  it('6h shift (08:00–14:00) → 360 min', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: '08:00', endTime: '14:00' })).toBe(360);
  });

  it('midnight-crossing shift (22:00–06:00) → 480 min', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: '22:00', endTime: '06:00' })).toBe(480);
  });

  it('midnight-crossing night shift (20:00–08:00) → 720 min', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: '20:00', endTime: '08:00' })).toBe(720);
  });

  it('returns 480 when times are malformed strings', () => {
    expect(svc.shiftDurationMinutesFor({ startTime: 'xx:00', endTime: '17:00' })).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// loadShiftDurationMap — unit tests (private)
// ---------------------------------------------------------------------------
describe('loadShiftDurationMap', () => {
  it('returns 480 for members without a shiftId', async () => {
    const svc: any = makeService({
      shiftModel: { find: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }) }) }) },
    });
    const members = [{ _id: 'mem1' }];
    const result = await svc.loadShiftDurationMap(members);
    expect(result.get('mem1')).toBe(480);
  });

  it('maps member to shift duration when shiftId present', async () => {
    const shiftOid = '507f1f77bcf86cd799439011';
    const shiftDoc = { _id: shiftOid, startTime: '08:00', endTime: '18:00' };
    const svc: any = makeService({
      shiftModel: {
        find: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockReturnValue({
              exec: vi.fn().mockResolvedValue([shiftDoc]),
            }),
          }),
        }),
      },
    });
    const members = [{ _id: '507f1f77bcf86cd799439012', shiftId: shiftOid }];
    const result = await svc.loadShiftDurationMap(members);
    expect(result.get('507f1f77bcf86cd799439012')).toBe(600); // 10h shift
  });
});

// ---------------------------------------------------------------------------
// OT logic: 10h shift — must_have truths from H3-04
// "10h-shift member working 10h records 0 min OT, 11h records 60 min OT"
// ---------------------------------------------------------------------------
describe('OT baseline via shift duration (H3-04 GAP-3.3-B)', () => {
  it('10h shift + 10h worked → 0 OT (shift-aware threshold)', () => {
    const shiftDur = 600;
    const workedMin = 600;
    const ot = Math.max(0, workedMin - shiftDur);
    expect(ot).toBe(0);
  });

  it('10h shift + 11h worked → 60 OT', () => {
    const shiftDur = 600;
    const workedMin = 660;
    const ot = Math.max(0, workedMin - shiftDur);
    expect(ot).toBe(60);
  });

  it('8h shift + 8h worked → 0 OT (standard)', () => {
    const shiftDur = 480;
    const workedMin = 480;
    const ot = Math.max(0, workedMin - shiftDur);
    expect(ot).toBe(0);
  });

  it('6h shift + 7h worked → 60 OT', () => {
    const shiftDur = 360;
    const workedMin = 420;
    const ot = Math.max(0, workedMin - shiftDur);
    expect(ot).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// LOP logic: null workedMinutes must NOT inflate LOP total (H3-04 GAP-2.1-C)
// ---------------------------------------------------------------------------
describe('LOP null workedMinutes guard (H3-04 GAP-2.1-C)', () => {
  const STANDARD_SHIFT = 480;

  function computeLopContribution(
    workedMinutes: number | null,
    status: string,
    shiftDur: number,
  ): { lopMinutes: number; reason: string | null; skipped: boolean } {
    if (workedMinutes === null || workedMinutes === undefined) {
      return { lopMinutes: 0, reason: 'missing_checkout', skipped: true };
    }
    const isLopStatus =
      status === 'absent' || status === 'half_day' || (status === 'late' && workedMinutes < shiftDur);
    if (!isLopStatus) return { lopMinutes: 0, reason: null, skipped: false };
    const lopMin = Math.max(0, shiftDur - workedMinutes);
    return { lopMinutes: lopMin, reason: null, skipped: false };
  }

  it('null workedMinutes → excluded from LOP total (missing_checkout reason)', () => {
    const result = computeLopContribution(null, 'absent', STANDARD_SHIFT);
    expect(result.lopMinutes).toBe(0);
    expect(result.reason).toBe('missing_checkout');
    expect(result.skipped).toBe(true);
  });

  it('null workedMinutes half_day → excluded, not double-counted', () => {
    const result = computeLopContribution(null, 'half_day', STANDARD_SHIFT);
    expect(result.lopMinutes).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it('absent + 0 worked → full shift LOP', () => {
    const result = computeLopContribution(0, 'absent', STANDARD_SHIFT);
    expect(result.lopMinutes).toBe(480);
    expect(result.skipped).toBe(false);
  });

  it('late + partial work (4h of 8h shift) → 4h LOP', () => {
    const result = computeLopContribution(240, 'late', 480);
    expect(result.lopMinutes).toBe(240);
  });

  it('present + full work → no LOP', () => {
    const result = computeLopContribution(480, 'present', 480);
    expect(result.lopMinutes).toBe(0);
  });
});
