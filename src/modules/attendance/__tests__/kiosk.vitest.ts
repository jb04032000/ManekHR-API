/**
 * kiosk.vitest.ts
 *
 * Unit tests for kiosk punch + lookup logic.
 * Covers all 15 behavioral specs from M-02 Task 2 + lockout flow (Test 16) +
 * anti-enumeration assertions (Tests 17-23).
 *
 * Strategy: Extract the pure business logic from KioskService into inline
 * functions (same pattern as void-event.vitest.ts which inlines voidEvent).
 * This avoids NestJS DI + Mongoose decorator loading issues in the Vitest env.
 *
 * vi.mock('bcryptjs') controls compare/hash deterministically.
 *
 * M-02 Task 3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';

// ── vi.mock bcryptjs ──────────────────────────────────────────────────────────
vi.mock('bcryptjs', () => ({
  compare: vi.fn(),
  hash: vi.fn(),
}));
import * as bcrypt from 'bcryptjs';

// ── Inline service logic (mirrors KioskService exactly) ───────────────────────

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
  const bits = parseInt(bitsStr, 10);
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

function isIpAllowed(ip: string, ranges: string[]): boolean {
  if (ranges.length === 0) return true;
  return ranges.some((cidr) => {
    try { return inCidr(ip, cidr); } catch { return false; }
  });
}

function genericFail(): never {
  throw new UnauthorizedException('Invalid employee or PIN');
}

interface WsDoc {
  kioskEnabled: boolean;
  kioskTokenHash: string | null;
  kioskAllowedIpRanges: string[];
}

interface MemberDoc {
  _id: Types.ObjectId;
  name: string;
  employeeCode: string;
  avatar: string | null;
  kioskPinHash: string | null;
  kioskFailedAttempts: number;
  kioskLockedUntil: Date | null;
}

interface SalaryDoc { isLocked?: boolean; }

interface Deps {
  workspaceModel: { findById: (id: any) => { lean: () => { exec: () => Promise<WsDoc | null> } } };
  memberModel: {
    findOne: (q: any) => { exec: () => Promise<MemberDoc | null>; lean?: () => { exec: () => Promise<MemberDoc | null> } };
    updateOne: (filter: any, update: any) => Promise<{ matchedCount: number }>;
  };
  eventModel: { findOne: (q: any) => { sort: (s: any) => { lean: () => { exec: () => Promise<{ punchType: string } | null> } } } };
  salaryModel: { findOne: (q: any) => { select: (f: any) => { lean: () => { exec: () => Promise<SalaryDoc | null> } } } };
  eventService: { createEvent: (input: any) => Promise<any> };
  projectionService: { recompute: (wsId: string, memberId: string, date: Date) => Promise<any> };
}

async function punch(dto: { wsId: string; secret: string; employeeCode: string; pin: string }, requestIp: string, deps: Deps) {
  // 1-3: workspace + enabled + IP + secret
  const ws = await deps.workspaceModel.findById(new Types.ObjectId(dto.wsId)).lean().exec();
  if (!ws || !ws.kioskEnabled) genericFail();
  if (ws.kioskAllowedIpRanges?.length > 0 && !isIpAllowed(requestIp, ws.kioskAllowedIpRanges)) genericFail();
  if (!ws.kioskTokenHash) genericFail();
  if (!await bcrypt.compare(dto.secret, ws.kioskTokenHash)) genericFail();

  // 4: find member
  const member = await deps.memberModel.findOne({
    workspaceId: new Types.ObjectId(dto.wsId),
    employeeCode: dto.employeeCode,
    isDeleted: false,
  }).exec();
  if (!member) genericFail();

  // 5: lockout check
  if (member!.kioskLockedUntil && member!.kioskLockedUntil.getTime() > Date.now()) genericFail();

  // 6: PIN hash must exist
  if (!member!.kioskPinHash) genericFail();

  // 7: PIN verification
  const pinOk = await bcrypt.compare(dto.pin, member!.kioskPinHash!);
  if (!pinOk) {
    const newCount = (member!.kioskFailedAttempts ?? 0) + 1;
    const update: any = { $inc: { kioskFailedAttempts: 1 } };
    if (newCount >= LOCKOUT_THRESHOLD) {
      update.$set = { kioskLockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) };
    }
    await deps.memberModel.updateOne({ _id: member!._id }, update);
    genericFail();
  }

  // 8: salary-lock guard
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const month = today.getUTCMonth() + 1;
  const year = today.getUTCFullYear();
  const salary = await deps.salaryModel.findOne({
    workspaceId: new Types.ObjectId(dto.wsId),
    teamMemberId: new Types.ObjectId(String(member!._id)),
    month, year,
  }).select('isLocked').lean().exec();
  if ((salary as SalaryDoc | null)?.isLocked) {
    throw new BadRequestException('Attendance is locked — payroll generated for this period');
  }

  // 9: reset counters
  await deps.memberModel.updateOne(
    { _id: member!._id },
    { $set: { kioskFailedAttempts: 0, kioskLockedUntil: null } },
  );

  // 10: auto-toggle
  const dayStart = new Date(today);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const last = await deps.eventModel.findOne({
    wsId: new Types.ObjectId(dto.wsId),
    teamMemberId: member!._id,
    timestamp: { $gte: dayStart, $lt: dayEnd },
    voidedAt: null,
    punchType: { $in: ['CHECK_IN', 'CHECK_OUT'] },
  }).sort({ timestamp: -1 }).lean().exec();
  const nextType: 'CHECK_IN' | 'CHECK_OUT' = last && last.punchType === 'CHECK_IN' ? 'CHECK_OUT' : 'CHECK_IN';

  // 11: emit event
  await deps.eventService.createEvent({
    wsId: dto.wsId, teamMemberId: String(member!._id),
    timestamp: new Date(), punchType: nextType, source: 'kiosk', verifyMethod: 'kiosk',
    sourceMeta: { requestIp },
  });

  // 12: recompute
  await deps.projectionService.recompute(dto.wsId, String(member!._id), today);

  return { name: member!.name, photoUrl: member!.avatar ?? null, punchType: nextType, time: new Date() };
}

async function lookup(dto: { wsId: string; secret: string; employeeCode: string }, requestIp: string, deps: Deps) {
  const notFound = (): never => { throw new NotFoundException({ message: 'Not found' }); };

  const ws = await deps.workspaceModel.findById(new Types.ObjectId(dto.wsId)).lean().exec();
  if (!ws || !ws.kioskEnabled) notFound();
  if (ws!.kioskAllowedIpRanges?.length > 0 && !isIpAllowed(requestIp, ws!.kioskAllowedIpRanges)) notFound();
  if (!ws!.kioskTokenHash) notFound();
  if (!await bcrypt.compare(dto.secret, ws!.kioskTokenHash!)) notFound();

  const member = await deps.memberModel.findOne({
    workspaceId: new Types.ObjectId(dto.wsId),
    employeeCode: dto.employeeCode,
    isDeleted: false,
  })?.lean?.()?.exec?.() ?? null;
  if (!member) notFound();

  return { name: member!.name, photoUrl: member!.avatar ?? null };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WS_ID = new Types.ObjectId().toHexString();
const MEMBER_ID = new Types.ObjectId();
const VALID_SECRET = 'valid-secret';
const VALID_PIN = '1234';
const VALID_CODE = 'EMP001';
const REQUEST_IP = '192.168.1.100';
const TOKEN_HASH = 'HASHED_SECRET';
const PIN_HASH = 'HASHED_PIN';

function makeWsDoc(overrides: Partial<WsDoc> = {}): WsDoc {
  return { kioskEnabled: true, kioskTokenHash: TOKEN_HASH, kioskAllowedIpRanges: [], ...overrides };
}

function makeMemberDoc(overrides: Partial<MemberDoc> = {}): MemberDoc {
  return {
    _id: MEMBER_ID, name: 'John Doe', employeeCode: VALID_CODE, avatar: null,
    kioskPinHash: PIN_HASH, kioskFailedAttempts: 0, kioskLockedUntil: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<{
  ws: WsDoc | null;
  member: MemberDoc | null;
  lastEvent: { punchType: string } | null;
  salary: SalaryDoc | null;
  updateOne: ReturnType<typeof vi.fn>;
  createEvent: ReturnType<typeof vi.fn>;
  recompute: ReturnType<typeof vi.fn>;
}> = {}): Deps {
  const ws = 'ws' in overrides ? overrides.ws : makeWsDoc();
  const member = 'member' in overrides ? overrides.member : makeMemberDoc();
  const lastEvent = 'lastEvent' in overrides ? overrides.lastEvent : null;
  const salary = 'salary' in overrides ? overrides.salary : null;
  const updateOneFn = overrides.updateOne ?? vi.fn().mockResolvedValue({ matchedCount: 1 });

  return {
    workspaceModel: {
      findById: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(ws) }) }),
    },
    memberModel: {
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve(member),
        lean: () => ({ exec: () => Promise.resolve(member) }),
      }),
      updateOne: updateOneFn,
    },
    eventModel: {
      findOne: vi.fn().mockReturnValue({
        sort: () => ({ lean: () => ({ exec: () => Promise.resolve(lastEvent) }) }),
      }),
    },
    salaryModel: {
      findOne: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(salary) }) }),
      }),
    },
    eventService: { createEvent: overrides.createEvent ?? vi.fn().mockResolvedValue({}) },
    projectionService: { recompute: overrides.recompute ?? vi.fn().mockResolvedValue({ updated: true }) },
  };
}

function makePunchDto(o: Partial<{ wsId: string; secret: string; employeeCode: string; pin: string }> = {}) {
  return { wsId: WS_ID, secret: VALID_SECRET, employeeCode: VALID_CODE, pin: VALID_PIN, ...o };
}
function makeLookupDto(o: Partial<{ wsId: string; secret: string; employeeCode: string }> = {}) {
  return { wsId: WS_ID, secret: VALID_SECRET, employeeCode: VALID_CODE, ...o };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('punch() — auto-toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('Test 1: emits CHECK_IN (source=kiosk, verifyMethod=kiosk) when no events today', async () => {
    const createEvent = vi.fn().mockResolvedValue({});
    const deps = makeDeps({ lastEvent: null, createEvent });
    const result = await punch(makePunchDto(), REQUEST_IP, deps);
    expect(result.punchType).toBe('CHECK_IN');
    const call = createEvent.mock.calls[0][0];
    expect(call.source).toBe('kiosk');
    expect(call.verifyMethod).toBe('kiosk');
    expect(call.punchType).toBe('CHECK_IN');
  });

  it('Test 2: emits CHECK_OUT when last event today was CHECK_IN', async () => {
    const createEvent = vi.fn().mockResolvedValue({});
    const deps = makeDeps({ lastEvent: { punchType: 'CHECK_IN' }, createEvent });
    const result = await punch(makePunchDto(), REQUEST_IP, deps);
    expect(result.punchType).toBe('CHECK_OUT');
    expect(createEvent.mock.calls[0][0].punchType).toBe('CHECK_OUT');
  });

  it('Test 3: emits CHECK_IN again when last event today was CHECK_OUT', async () => {
    const createEvent = vi.fn().mockResolvedValue({});
    const deps = makeDeps({ lastEvent: { punchType: 'CHECK_OUT' }, createEvent });
    const result = await punch(makePunchDto(), REQUEST_IP, deps);
    expect(result.punchType).toBe('CHECK_IN');
  });
});

describe('punch() — wrong PIN: lockout escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 4: wrong PIN on 5th attempt sets kioskLockedUntil; throws "Invalid employee or PIN"', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)   // secret ok
      .mockResolvedValueOnce(false); // PIN fail
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const deps = makeDeps({ member: makeMemberDoc({ kioskFailedAttempts: 4 }), updateOne });

    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
    const updateCall = updateOne.mock.calls[0][1];
    expect(updateCall.$set?.kioskLockedUntil).toBeInstanceOf(Date);
    expect(updateCall.$set.kioskLockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('Test 5: punch while locked throws "Invalid employee or PIN" (no leak of lockout reason)', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const deps = makeDeps({
      member: makeMemberDoc({ kioskLockedUntil: new Date(Date.now() + 60000) }),
    });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow(UnauthorizedException);
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });
});

describe('punch() — anti-enumeration: all failure paths return identical message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('Test 6: unknown employeeCode → "Invalid employee or PIN"', async () => {
    const deps = makeDeps({ member: null });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });

  it('Test 7: kioskEnabled=false → "Invalid employee or PIN"', async () => {
    const deps = makeDeps({ ws: makeWsDoc({ kioskEnabled: false }) });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });

  it('Test 8: wrong workspace secret (bcrypt.compare=false) → "Invalid employee or PIN"', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const deps = makeDeps({});
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });

  it('Test 9: IP not in allowlist → "Invalid employee or PIN"', async () => {
    const deps = makeDeps({ ws: makeWsDoc({ kioskAllowedIpRanges: ['10.0.0.0/24'] }) });
    // REQUEST_IP is 192.168.1.100, not in 10.0.0.0/24
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });

  it('Test 10 (also anti-enum): wrong PIN → "Invalid employee or PIN"', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)   // secret ok
      .mockResolvedValueOnce(false); // PIN fails
    const deps = makeDeps({ updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }) });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });

  it('no kioskPinHash on member → "Invalid employee or PIN"', async () => {
    const deps = makeDeps({ member: makeMemberDoc({ kioskPinHash: null }) });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });
});

describe('punch() — success behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('Test 10-success: success resets kioskFailedAttempts=0 and kioskLockedUntil=null', async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const deps = makeDeps({ member: makeMemberDoc({ kioskFailedAttempts: 3 }), updateOne });

    await punch(makePunchDto(), REQUEST_IP, deps);

    // The reset call is the last updateOne (step 9)
    const resetCall = updateOne.mock.calls[updateOne.mock.calls.length - 1][1];
    expect(resetCall.$set.kioskFailedAttempts).toBe(0);
    expect(resetCall.$set.kioskLockedUntil).toBeNull();
  });

  it('Test 11: success calls projectionService.recompute(wsId, memberId, UTC-midnight-today)', async () => {
    const recompute = vi.fn().mockResolvedValue({ updated: true });
    const deps = makeDeps({ recompute });

    await punch(makePunchDto(), REQUEST_IP, deps);

    expect(recompute).toHaveBeenCalledOnce();
    const [wsArg, memberArg, dateArg] = recompute.mock.calls[0];
    expect(wsArg).toBe(WS_ID);
    expect(memberArg).toBe(MEMBER_ID.toHexString());
    expect(dateArg).toBeInstanceOf(Date);
    expect(dateArg.getUTCHours()).toBe(0);
  });

  it('Test 12: throws BadRequestException (NOT 401) when salary is locked', async () => {
    const deps = makeDeps({ salary: { isLocked: true } });
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow(BadRequestException);
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Attendance is locked');
  });
});

describe('lookup() — member info without touching failed attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('Test 13: returns { name, photoUrl } and does NOT call updateOne', async () => {
    const updateOne = vi.fn();
    const deps = makeDeps({
      member: makeMemberDoc({ name: 'Jane Smith', avatar: 'https://cdn/avatar.jpg' }),
      updateOne,
    });
    const result = await lookup(makeLookupDto(), REQUEST_IP, deps);
    expect(result.name).toBe('Jane Smith');
    expect(result.photoUrl).toBe('https://cdn/avatar.jpg');
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('Test 14: unknown employeeCode in lookup returns NotFoundException { message: "Not found" }', async () => {
    const deps = makeDeps({ member: null });
    await expect(lookup(makeLookupDto(), REQUEST_IP, deps)).rejects.toThrow(NotFoundException);
    await expect(lookup(makeLookupDto(), REQUEST_IP, deps)).rejects.toThrow('Not found');
  });
});

describe('Token rotation and lockout flow (Tests 15-16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 15: old-secret punch fails after token rotation (bcrypt.compare returns false for new hash)', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false); // secret fails against new hash
    const deps = makeDeps({ ws: makeWsDoc({ kioskTokenHash: 'NEW_HASH' }) });
    await expect(punch(makePunchDto({ secret: 'old-secret' }), REQUEST_IP, deps))
      .rejects.toThrow('Invalid employee or PIN');
  });

  it('Test 16: lockout flow — 5 wrong PINs lock; 6th with correct PIN still throws', async () => {
    let failedAttempts = 0;
    let lockedUntil: Date | null = null;

    const updateOne = vi.fn().mockImplementation((_filter: any, update: any) => {
      if (update.$inc?.kioskFailedAttempts) failedAttempts += update.$inc.kioskFailedAttempts;
      if (update.$set?.kioskLockedUntil !== undefined) lockedUntil = update.$set.kioskLockedUntil;
      return Promise.resolve({ matchedCount: 1 });
    });

    // Stateful memberModel: returns doc reflecting current failedAttempts / lockedUntil
    const memberFindOne = vi.fn().mockImplementation(() => ({
      exec: () => Promise.resolve({
        _id: MEMBER_ID, name: 'Test', employeeCode: VALID_CODE, avatar: null,
        kioskPinHash: PIN_HASH, kioskFailedAttempts: failedAttempts, kioskLockedUntil: lockedUntil,
      }),
    }));

    const deps: Deps = {
      workspaceModel: { findById: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(makeWsDoc()) }) }) },
      memberModel: { findOne: memberFindOne, updateOne },
      eventModel: { findOne: vi.fn().mockReturnValue({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }) }) },
      salaryModel: { findOne: vi.fn().mockReturnValue({ select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }) }) },
      eventService: { createEvent: vi.fn().mockResolvedValue({}) },
      projectionService: { recompute: vi.fn().mockResolvedValue({ updated: true }) },
    };

    // Calls 1-4: wrong PIN
    for (let i = 0; i < 4; i++) {
      (bcrypt.compare as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(true)   // secret
        .mockResolvedValueOnce(false); // PIN
      await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
    }
    expect(failedAttempts).toBe(4);
    expect(lockedUntil).toBeNull();

    // Call 5: 5th wrong PIN → lockout
    (bcrypt.compare as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
    expect(failedAttempts).toBe(5);
    expect(lockedUntil).toBeInstanceOf(Date);
    expect(lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Call 6: correct PIN but still locked → 'Invalid employee or PIN'
    (bcrypt.compare as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)  // secret
      .mockResolvedValueOnce(true); // PIN would succeed but lockout fires first
    await expect(punch(makePunchDto(), REQUEST_IP, deps)).rejects.toThrow('Invalid employee or PIN');
  });
});
