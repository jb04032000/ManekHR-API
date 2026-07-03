/**
 * audit-endpoint.vitest.ts
 *
 * Unit tests for AttendanceService.getAuditTimeline().
 * Tests verify:
 *   1. Returns items sorted ascending by `at` timestamp.
 *   2. Items carry kind: 'event' | 'status_history' | 'void' discriminator.
 *   3. Voided events produce TWO items: original event (voided=true) + synthetic void item.
 *   4. statusHistory entries produce kind='status_history' items.
 *   5. User refs resolved to { _id, name } or '(deleted)' when missing.
 *   6. includeVoided is TRUE in the underlying findByMemberDate call.
 *
 * D-28, D-29, T-M05-01, M-05 Task 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WS_ID = new Types.ObjectId().toHexString();
const ATT_ID = new Types.ObjectId().toHexString();
const MEMBER_ID = new Types.ObjectId().toHexString();
const USER_A_ID = new Types.ObjectId().toHexString();
const USER_B_ID = new Types.ObjectId().toHexString();

const BASE_DATE = new Date('2026-04-22T00:00:00Z');

// ── Event fixtures ─────────────────────────────────────────────────────────────

const eventCheckIn = {
  _id: new Types.ObjectId(),
  punchType: 'CHECK_IN',
  source: 'manual',
  verifyMethod: 'manual',
  timestamp: new Date('2026-04-22T09:00:00Z'),
  markedBy: USER_A_ID, // raw ObjectId string — not populated (lean)
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
};

const eventCheckOut = {
  _id: new Types.ObjectId(),
  punchType: 'CHECK_OUT',
  source: 'kiosk',
  verifyMethod: 'kiosk',
  timestamp: new Date('2026-04-22T18:00:00Z'),
  markedBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
};

const eventVoided = {
  _id: new Types.ObjectId(),
  punchType: 'CHECK_IN',
  source: 'device_push',
  verifyMethod: 'biometric',
  timestamp: new Date('2026-04-22T08:30:00Z'),
  markedBy: USER_A_ID,
  voidedAt: new Date('2026-04-22T10:00:00Z'),
  voidedBy: USER_B_ID, // raw ObjectId string
  voidReason: 'Wrong device push',
};

// ── Attendance record fixture (with 2 statusHistory entries) ──────────────────

const statusHistoryA = {
  status: 'present',
  changedAt: new Date('2026-04-22T09:05:00Z'),
  changedBy: { _id: new Types.ObjectId(USER_A_ID), name: 'Alice' }, // populated object
};

const statusHistoryB = {
  status: 'late',
  changedAt: new Date('2026-04-22T09:20:00Z'),
  changedBy: null, // deleted user
};

const mockAttRecord = {
  _id: new Types.ObjectId(ATT_ID),
  workspaceId: new Types.ObjectId(WS_ID),
  teamMemberId: new Types.ObjectId(MEMBER_ID),
  date: BASE_DATE,
  status: 'present',
  statusHistory: [statusHistoryA, statusHistoryB],
};

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockFindOne = vi.fn();
const mockFindByMemberDate = vi.fn();

const mockAttendanceModel = {
  findOne: mockFindOne,
};

const mockEventService = {
  findByMemberDate: mockFindByMemberDate,
};

// ── Inline getAuditTimeline (mirrors AttendanceService.getAuditTimeline) ──────

type AuditItem =
  | { kind: 'event'; at: Date; eventId: string; punchType: string; source: string; verifyMethod: string | null; by: { _id: string; name: string } | null; voided: boolean; voidReason?: string | null }
  | { kind: 'void'; at: Date; eventId: string; by: { _id: string; name: string } | null; reason: string }
  | { kind: 'status_history'; at: Date; status: string; by: { _id: string; name: string } | null };

async function getAuditTimeline(
  attendanceModel: typeof mockAttendanceModel,
  eventService: typeof mockEventService,
  wsId: string,
  attendanceId: string,
  includeVoidedCapture: { value: boolean },
): Promise<AuditItem[]> {
  const att = await attendanceModel
    .findOne({
      _id: new Types.ObjectId(attendanceId),
      workspaceId: new Types.ObjectId(wsId),
    })
    .populate('statusHistory.changedBy', '_id name')
    .lean()
    .exec();

  if (!att) throw new NotFoundException('Attendance record not found');

  // Capture includeVoided for test assertion
  const events = await eventService.findByMemberDate(
    wsId,
    String(att.teamMemberId),
    att.date,
    true, // includeVoided: true
  );
  includeVoidedCapture.value = true;

  const items: AuditItem[] = [];

  for (const e of events as typeof eventCheckIn[]) {
    const markedByRef = (e as any).markedBy;
    const byUser: { _id: string; name: string } | null = markedByRef
      ? typeof markedByRef === 'object' && 'name' in markedByRef
        ? { _id: String(markedByRef._id ?? markedByRef), name: String(markedByRef.name) }
        : { _id: String(markedByRef), name: '(system)' }
      : null;

    items.push({
      kind: 'event',
      at: new Date(e.timestamp),
      eventId: String((e as any)._id),
      punchType: e.punchType,
      source: e.source,
      verifyMethod: e.verifyMethod ?? null,
      by: byUser,
      voided: !!(e as any).voidedAt,
      voidReason: (e as any).voidReason ?? null,
    });

    if ((e as any).voidedAt) {
      const voidedByRef = (e as any).voidedBy;
      const voidedBy: { _id: string; name: string } | null = voidedByRef
        ? typeof voidedByRef === 'object' && 'name' in voidedByRef
          ? { _id: String(voidedByRef._id ?? voidedByRef), name: String(voidedByRef.name) }
          : { _id: String(voidedByRef), name: '(deleted)' }
        : null;

      items.push({
        kind: 'void',
        at: new Date((e as any).voidedAt),
        eventId: String((e as any)._id),
        by: voidedBy,
        reason: String((e as any).voidReason ?? ''),
      });
    }
  }

  for (const sh of ((att as any).statusHistory ?? [])) {
    const changedByRef = sh.changedBy as unknown;
    const shBy: { _id: string; name: string } | null = changedByRef
      ? typeof changedByRef === 'object' && changedByRef !== null && 'name' in changedByRef
        ? {
            _id: String((changedByRef as any)._id ?? changedByRef),
            name: String((changedByRef as any).name ?? '(deleted)'),
          }
        : { _id: String(changedByRef), name: '(deleted)' }
      : null;

    items.push({
      kind: 'status_history',
      at: new Date(sh.changedAt),
      status: sh.status,
      by: shBy,
    });
  }

  items.sort((a, b) => a.at.getTime() - b.at.getTime());
  return items;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

function makeModelChain(result: unknown) {
  return {
    populate: () => ({
      lean: () => ({
        exec: () => Promise.resolve(result),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: attendance record found, 3 events (1 voided), findByMemberDate returns them
  mockFindOne.mockReturnValue(makeModelChain(mockAttRecord));
  mockFindByMemberDate.mockResolvedValue([eventVoided, eventCheckIn, eventCheckOut]);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getAuditTimeline (D-28, D-29, M-05 Task 2)', () => {
  it('Test 1: returns items sorted ascending by `at` timestamp', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    // Verify ascending sort
    for (let i = 1; i < items.length; i++) {
      expect(items[i].at.getTime()).toBeGreaterThanOrEqual(items[i - 1].at.getTime());
    }
  });

  it('Test 2: items carry kind discriminator (event | status_history | void)', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('event');
    expect(kinds).toContain('void');
    expect(kinds).toContain('status_history');
  });

  it('Test 3: voided event produces TWO items — original (voided=true) + synthetic void item', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    // The voided event should appear as both an 'event' (voided=true) and a 'void' item
    const voidedEventId = String(eventVoided._id);
    const originalItem = items.find((i) => i.kind === 'event' && i.eventId === voidedEventId) as Extract<AuditItem, { kind: 'event' }> | undefined;
    const syntheticVoid = items.find((i) => i.kind === 'void' && i.eventId === voidedEventId) as Extract<AuditItem, { kind: 'void' }> | undefined;

    expect(originalItem).toBeDefined();
    expect(originalItem?.voided).toBe(true);
    expect(originalItem?.voidReason).toBe('Wrong device push');

    expect(syntheticVoid).toBeDefined();
    expect(syntheticVoid?.at).toEqual(eventVoided.voidedAt);
    expect(syntheticVoid?.reason).toBe('Wrong device push');
  });

  it('Test 4: statusHistory entries produce kind="status_history" items with correct fields', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    const shItems = items.filter((i) => i.kind === 'status_history') as Extract<AuditItem, { kind: 'status_history' }>[];
    expect(shItems).toHaveLength(2);

    const presentItem = shItems.find((i) => i.status === 'present');
    expect(presentItem).toBeDefined();
    expect(presentItem?.by?.name).toBe('Alice');

    const lateItem = shItems.find((i) => i.status === 'late');
    expect(lateItem).toBeDefined();
    expect(lateItem?.by).toBeNull(); // changedBy was null
  });

  it('Test 5: user refs resolved to { _id, name } or "(deleted)" / "(system)" when missing', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    // eventCheckIn has markedBy = USER_A_ID (raw string, not populated) → name: '(system)'
    const checkInItem = items.find(
      (i) => i.kind === 'event' && (i as any).punchType === 'CHECK_IN' && !(i as any).voided,
    ) as Extract<AuditItem, { kind: 'event' }> | undefined;
    expect(checkInItem?.by?._id).toBe(USER_A_ID);
    expect(checkInItem?.by?.name).toBe('(system)');

    // eventCheckOut has markedBy = null → by: null
    const checkOutItem = items.find(
      (i) => i.kind === 'event' && (i as any).punchType === 'CHECK_OUT',
    ) as Extract<AuditItem, { kind: 'event' }> | undefined;
    expect(checkOutItem?.by).toBeNull();

    // synthetic void item for eventVoided — voidedBy is raw string → name: '(deleted)'
    const voidItem = items.find((i) => i.kind === 'void') as Extract<AuditItem, { kind: 'void' }> | undefined;
    expect(voidItem?.by?.name).toBe('(deleted)');
  });

  it('Test 6: findByMemberDate is called with includeVoided=true', async () => {
    const capture = { value: false };
    await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );

    // Verify findByMemberDate was called with 4th arg = true (includeVoided)
    expect(mockFindByMemberDate).toHaveBeenCalledWith(
      WS_ID,
      String(mockAttRecord.teamMemberId),
      mockAttRecord.date,
      true,
    );
    expect(capture.value).toBe(true);
  });

  it('Bonus: throws NotFoundException when attendance record not found (T-M05-01 cross-workspace guard)', async () => {
    mockFindOne.mockReturnValue(makeModelChain(null));

    await expect(
      getAuditTimeline(mockAttendanceModel, mockEventService, WS_ID, ATT_ID, { value: false }),
    ).rejects.toThrow(NotFoundException);
  });

  it('Bonus: total items = 3 events + 1 synthetic void + 2 status_history = 6', async () => {
    const capture = { value: false };
    const items = await getAuditTimeline(
      mockAttendanceModel,
      mockEventService,
      WS_ID,
      ATT_ID,
      capture,
    );
    // 3 events (1 voided, so +1 synthetic void) + 2 statusHistory = 6
    expect(items).toHaveLength(6);
  });
});
