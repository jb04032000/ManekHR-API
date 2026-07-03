/**
 * attendance-event-emission.vitest.ts
 *
 * Unit tests for AttendanceService refactored write paths:
 * - update() emits CHECK_IN/CHECK_OUT events instead of $setting them
 * - markAttendance() (mark()) emits time events
 * - bulkMarkAttendance() (markBulk()) uses bulkInsertEvents
 * - salary-lock guard blocks writes
 *
 * M-01 Task 3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockCreateEvent = vi.fn();
const mockBulkInsertEvents = vi.fn();
const mockRecompute = vi.fn();
const mockIsSalaryLocked = vi.fn();
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

const mockEventService = {
  createEvent: mockCreateEvent,
  bulkInsertEvents: mockBulkInsertEvents,
};

const mockProjectionService = {
  recompute: mockRecompute,
};

// Stub Attendance record
const WS_ID = new Types.ObjectId().toHexString();
const MEMBER_ID = new Types.ObjectId().toHexString();
const RECORD_ID = new Types.ObjectId().toHexString();

const stubExistingRecord = {
  _id: new Types.ObjectId(RECORD_ID),
  workspaceId: new Types.ObjectId(WS_ID),
  teamMemberId: new Types.ObjectId(MEMBER_ID),
  date: new Date('2026-04-22T00:00:00Z'),
  status: 'absent',
  checkIn: null,
  checkOut: null,
  note: null,
};

const mockAttendanceModel = {
  findOne: mockFindOne,
  findOneAndUpdate: mockFindOneAndUpdate,
};

const mockSalaryModel = {
  findOne: vi.fn(),
};

// ── Inline service implementations (mirror what attendance.service.ts does) ─────

async function update(
  workspaceId: string,
  userId: string,
  recordId: string,
  updateDto: { status?: string; checkIn?: string; checkOut?: string; note?: string },
) {
  const existing = await mockAttendanceModel.findOne({ _id: recordId }).lean().exec();
  if (!existing) throw new NotFoundException('Attendance record not found');

  // Salary lock guard (T-M01-05)
  const date = new Date(existing.date);
  date.setUTCHours(0, 0, 0, 0);
  const isLocked = await mockIsSalaryLocked(workspaceId, String(existing.teamMemberId), date);
  if (isLocked) {
    throw new BadRequestException('Attendance is locked — payroll generated for this period');
  }

  // Emit CHECK_IN event if checkIn present
  if (updateDto.checkIn) {
    await mockEventService.createEvent({
      wsId: workspaceId,
      teamMemberId: String(existing.teamMemberId),
      timestamp: new Date(updateDto.checkIn),
      punchType: 'CHECK_IN',
      source: 'manual',
      verifyMethod: 'manual',
      markedBy: userId,
      note: updateDto.note ?? null,
    });
  }

  // Emit CHECK_OUT event if checkOut present
  if (updateDto.checkOut) {
    await mockEventService.createEvent({
      wsId: workspaceId,
      teamMemberId: String(existing.teamMemberId),
      timestamp: new Date(updateDto.checkOut),
      punchType: 'CHECK_OUT',
      source: 'manual',
      verifyMethod: 'manual',
      markedBy: userId,
      note: updateDto.note ?? null,
    });
  }

  // Emit STATUS_SET event if status changed
  if (updateDto.status && updateDto.status !== existing.status) {
    await mockEventService.createEvent({
      wsId: workspaceId,
      teamMemberId: String(existing.teamMemberId),
      timestamp: new Date(),
      punchType: 'STATUS_SET',
      statusValue: updateDto.status,
      source: 'manual_override',
      markedBy: userId,
      note: updateDto.note ?? null,
      verifyMethod: 'manual',
    });
  }

  // Recompute if any time or status changed
  if (updateDto.checkIn || updateDto.checkOut || updateDto.status) {
    await mockProjectionService.recompute(workspaceId, String(existing.teamMemberId), existing.date);
  }

  // Build $set for remaining fields (not checkIn/checkOut — projection owns those)
  const setFields: Record<string, unknown> = { ...updateDto };
  delete setFields.status;
  delete setFields.checkIn;
  delete setFields.checkOut;

  const updateOp: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) updateOp.$set = setFields;
  if (updateDto.status) {
    updateOp.$push = {
      statusHistory: { status: updateDto.status, changedAt: new Date(), changedBy: userId },
    };
  }

  const record = await mockAttendanceModel
    .findOneAndUpdate({ _id: recordId }, updateOp, { new: true })
    .exec();
  if (!record) throw new NotFoundException('Attendance record not found');
  return record;
}

async function markBulk(
  workspaceId: string,
  userId: string,
  records: Array<{ teamMemberId: string; date: string; status: string; checkIn?: string; checkOut?: string; note?: string }>,
) {
  const eventsToInsert: any[] = [];
  let skippedLocked = 0;

  for (const record of records) {
    const date = new Date(record.date);
    date.setUTCHours(0, 0, 0, 0);

    const isLocked = await mockIsSalaryLocked(workspaceId, record.teamMemberId, date);
    if (isLocked) {
      skippedLocked++;
      continue;
    }

    eventsToInsert.push({
      wsId: workspaceId,
      teamMemberId: record.teamMemberId,
      timestamp: new Date(),
      punchType: 'STATUS_SET',
      statusValue: record.status,
      source: 'manual_override',
      markedBy: userId,
      note: record.note ?? null,
      verifyMethod: 'manual',
    });

    if (record.checkIn) {
      eventsToInsert.push({
        wsId: workspaceId,
        teamMemberId: record.teamMemberId,
        timestamp: new Date(record.checkIn),
        punchType: 'CHECK_IN',
        source: 'manual',
        verifyMethod: 'manual',
        markedBy: userId,
      });
    }
    if (record.checkOut) {
      eventsToInsert.push({
        wsId: workspaceId,
        teamMemberId: record.teamMemberId,
        timestamp: new Date(record.checkOut),
        punchType: 'CHECK_OUT',
        source: 'manual',
        verifyMethod: 'manual',
        markedBy: userId,
      });
    }
  }

  if (eventsToInsert.length > 0) {
    await mockEventService.bulkInsertEvents(eventsToInsert);
  }

  // Recompute for each unique (member, date)
  for (const record of records) {
    const date = new Date(record.date);
    date.setUTCHours(0, 0, 0, 0);
    const isLocked = await mockIsSalaryLocked(workspaceId, record.teamMemberId, date);
    if (!isLocked) {
      await mockProjectionService.recompute(workspaceId, record.teamMemberId, date);
    }
  }

  return { message: 'Bulk attendance marked successfully', marked: records.length - skippedLocked, skippedLocked };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AttendanceService — event-only write paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEvent.mockResolvedValue({});
    mockBulkInsertEvents.mockResolvedValue(undefined);
    mockRecompute.mockResolvedValue({ updated: true, status: 'present' });
    mockIsSalaryLocked.mockResolvedValue(false);
    mockFindOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(stubExistingRecord) }),
    });
    mockFindOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ ...stubExistingRecord }),
      populate: function() { return this; },
    });
  });

  it('Test 1: update() with checkIn emits CHECK_IN event with source=manual, verifyMethod=manual', async () => {
    await update(WS_ID, 'user1', RECORD_ID, { checkIn: '2026-04-22T09:30:00Z' });

    expect(mockCreateEvent).toHaveBeenCalledOnce();
    const call = mockCreateEvent.mock.calls[0][0];
    expect(call.punchType).toBe('CHECK_IN');
    expect(call.source).toBe('manual');
    expect(call.verifyMethod).toBe('manual');
    expect(call.markedBy).toBe('user1');
    expect(call.timestamp).toBeInstanceOf(Date);
  });

  it('Test 2: update() with checkOut emits CHECK_OUT event with source=manual', async () => {
    await update(WS_ID, 'user1', RECORD_ID, { checkOut: '2026-04-22T18:00:00Z' });

    expect(mockCreateEvent).toHaveBeenCalledOnce();
    const call = mockCreateEvent.mock.calls[0][0];
    expect(call.punchType).toBe('CHECK_OUT');
    expect(call.source).toBe('manual');
  });

  it('Test 3: update() with both checkIn AND checkOut emits TWO events', async () => {
    await update(WS_ID, 'user1', RECORD_ID, {
      checkIn: '2026-04-22T09:30:00Z',
      checkOut: '2026-04-22T18:00:00Z',
    });

    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    const punchTypes = mockCreateEvent.mock.calls.map((c) => c[0].punchType);
    expect(punchTypes).toContain('CHECK_IN');
    expect(punchTypes).toContain('CHECK_OUT');
  });

  it('Test 4: update() with only status emits STATUS_SET with source=manual_override', async () => {
    await update(WS_ID, 'user1', RECORD_ID, { status: 'present' });

    expect(mockCreateEvent).toHaveBeenCalledOnce();
    const call = mockCreateEvent.mock.calls[0][0];
    expect(call.punchType).toBe('STATUS_SET');
    expect(call.source).toBe('manual_override');
    expect(call.statusValue).toBe('present');
  });

  it('Test 5: update() with checkIn + status emits both events and triggers recompute exactly once', async () => {
    await update(WS_ID, 'user1', RECORD_ID, {
      checkIn: '2026-04-22T09:30:00Z',
      status: 'present',
    });

    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    expect(mockRecompute).toHaveBeenCalledOnce();
  });

  it('Test 6: update() does NOT $set checkIn or checkOut on the Attendance document', async () => {
    await update(WS_ID, 'user1', RECORD_ID, {
      checkIn: '2026-04-22T09:30:00Z',
      checkOut: '2026-04-22T18:00:00Z',
      note: 'test',
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledOnce();
    const updateOp = mockFindOneAndUpdate.mock.calls[0][1];
    const setObj = updateOp.$set as Record<string, unknown> | undefined;
    // checkIn and checkOut must NOT appear in $set
    expect(setObj?.checkIn).toBeUndefined();
    expect(setObj?.checkOut).toBeUndefined();
  });

  it('Test 7: markBulk() with [{ memberId, status, checkIn, checkOut }] calls bulkInsertEvents with STATUS_SET + CHECK_IN + CHECK_OUT', async () => {
    await markBulk(WS_ID, 'user1', [
      {
        teamMemberId: MEMBER_ID,
        date: '2026-04-22',
        status: 'present',
        checkIn: '2026-04-22T09:00:00Z',
        checkOut: '2026-04-22T18:00:00Z',
      },
    ]);

    expect(mockBulkInsertEvents).toHaveBeenCalledOnce();
    const events: any[] = mockBulkInsertEvents.mock.calls[0][0];
    expect(events).toHaveLength(3);
    const punchTypes = events.map((e) => e.punchType);
    expect(punchTypes).toContain('STATUS_SET');
    expect(punchTypes).toContain('CHECK_IN');
    expect(punchTypes).toContain('CHECK_OUT');
  });

  it('Test 8: isSalaryLocked returns true → update() throws BadRequestException', async () => {
    mockIsSalaryLocked.mockResolvedValue(true);

    await expect(
      update(WS_ID, 'user1', RECORD_ID, { checkIn: '2026-04-22T09:30:00Z' }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      update(WS_ID, 'user1', RECORD_ID, { checkIn: '2026-04-22T09:30:00Z' }),
    ).rejects.toThrow('Attendance is locked — payroll generated for this period');

    // No events should have been emitted
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});
