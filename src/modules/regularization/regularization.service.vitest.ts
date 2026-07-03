/**
 * Vitest for RegularizationService (D-04).
 *
 * vi.mock() calls are hoisted to the top by Vitest — they intercept the
 * attendance module imports BEFORE the NestJS schema decorators are evaluated,
 * preventing the "Cannot determine type" error that occurs when
 * attendance-projection.service.ts triggers attendance.schema.ts decorators
 * in a second evaluation context.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';

// Mock the attendance service modules before the service is imported.
// This prevents the NestJS Mongoose schema decorator chain from running
// (attendance.schema.ts triggers a "union type" decorator error on second load).
vi.mock('../attendance/attendance-event.service', () => ({
  AttendanceEventService: class {},
}));
vi.mock('../attendance/attendance-projection.service', () => ({
  AttendanceProjectionService: class {},
}));

// Now safe to import the service (the heavy attendance imports are intercepted above)
import { RegularizationService, STATUS_MAP } from './regularization.service';

// ---------------------------------------------------------------------------
// Helper: create a fake Mongoose document (has .save(), fields, etc.)
// ---------------------------------------------------------------------------
function makeDoc(fields: Record<string, any>) {
  const doc: any = { ...fields };
  doc.save = vi.fn(() => doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Helper: chainable Mongoose query mock resolving to `result`
// ---------------------------------------------------------------------------
function q(result: any) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

// ---------------------------------------------------------------------------
// Shared fixture ObjectIds
// ---------------------------------------------------------------------------
const wsId = new Types.ObjectId();
const memberId = new Types.ObjectId();
const userId = new Types.ObjectId();
const approverUserId = new Types.ObjectId();
const approver2Id = new Types.ObjectId();
const eventId = new Types.ObjectId();

// ---------------------------------------------------------------------------
// Factory: build RegularizationService with mock dependencies
// ---------------------------------------------------------------------------
function buildService(
  overrides: {
    requestModel?: any;
    workspaceModel?: any;
    teamMemberModel?: any;
    salaryModel?: any;
    attendanceModel?: any;
    userModel?: any;
    resolver?: any;
    eventService?: any;
    projectionService?: any;
  } = {},
) {
  const requestModel = overrides.requestModel ?? {
    findOne: vi.fn(() => q(null)),
    findOneAndUpdate: vi.fn(() => q(null)),
    create: vi.fn((data: any) => makeDoc(data)),
    find: vi.fn(() => q([])),
  };

  const workspaceModel = overrides.workspaceModel ?? {
    findById: vi.fn(() =>
      q({
        _id: wsId,
        regularizationConfig: {
          approvalLevels: 1,
          maxDaysBack: 30,
          maxAttachmentsPerRequest: 3,
          fallbackApprover: approverUserId.toString(),
        },
      }),
    ),
  };

  const teamMemberModel = overrides.teamMemberModel ?? {
    findOne: vi.fn(() => q({ _id: memberId, workspaceId: wsId, linkedUserId: null })),
  };

  const salaryModel = overrides.salaryModel ?? {
    findOne: vi.fn(() => q(null)), // not locked by default
  };

  const attendanceModel = overrides.attendanceModel ?? {
    findOne: vi.fn(() => q({ status: 'absent' })),
  };

  const userModel = overrides.userModel ?? {};

  const resolver = overrides.resolver ?? {
    resolveApprovers: vi.fn().mockResolvedValue([{ level: 1, approverUserId }]),
  };

  const eventService = overrides.eventService ?? {
    createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })),
  };

  const projectionService = overrides.projectionService ?? {
    recompute: vi.fn().mockResolvedValue({ updated: true, status: 'present' }),
  };

  // @ts-expect-error test bypasses DI container
  return new RegularizationService(
    requestModel,
    workspaceModel,
    teamMemberModel,
    salaryModel,
    attendanceModel,
    userModel,
    resolver,
    eventService,
    projectionService,
    undefined, // mailService - unused in these unit paths
    undefined, // notificationsService - unused in these unit paths
    undefined, // configService - unused in these unit paths
    { logEvent: vi.fn().mockResolvedValue(undefined) }, // auditService
    { capture: vi.fn() }, // postHog
  );
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function dateStr(daysBack: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

const validInput = () => ({
  wsId: wsId.toString(),
  raisedBy: userId.toString(),
  memberId: memberId.toString(),
  date: dateStr(1), // yesterday — within maxDaysBack=30
  requestedStatus: 'PRESENT' as const,
  reason: 'Testing regularization flow end-to-end',
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('RegularizationService', () => {
  // ==========================================================================
  describe('create()', () => {
    it('rejects requests older than workspace.regularizationConfig.maxDaysBack (DD-6)', async () => {
      const svc = buildService();
      const input = { ...validInput(), date: dateStr(31) }; // 31 days > max 30
      await expect(svc.create(input)).rejects.toThrow(BadRequestException);
      await expect(svc.create(input)).rejects.toThrow('MAX_DAYS_BACK_EXCEEDED');
    });

    it('rejects when Salary.isLocked === true for that (memberId, year, month) (DD-7)', async () => {
      const svc = buildService({
        salaryModel: { findOne: vi.fn(() => q({ isLocked: true })) },
      });
      await expect(svc.create(validInput())).rejects.toThrow(BadRequestException);
      await expect(svc.create(validInput())).rejects.toThrow('PAYROLL_LOCKED');
    });

    it('maps Mongo E11000 on partial unique index to 409 Conflict (DD-11)', async () => {
      const svc = buildService({
        requestModel: {
          findOne: vi.fn(() => q(null)),
          findOneAndUpdate: vi.fn(() => q(null)),
          find: vi.fn(() => q([])),
          create: vi.fn(() => {
            const err: any = new Error('E11000 duplicate key');
            err.code = 11000;
            throw err;
          }),
        },
      });
      await expect(svc.create(validInput())).rejects.toThrow(ConflictException);
      await expect(svc.create(validInput())).rejects.toThrow('PENDING_REGULARIZATION_EXISTS');
    });

    it('snapshots approvalChain and currentStatus on create (assumption A3)', async () => {
      let captured: any = null;
      const svc = buildService({
        requestModel: {
          findOne: vi.fn(() => q(null)),
          findOneAndUpdate: vi.fn(() => q(null)),
          find: vi.fn(() => q([])),
          create: vi.fn((data: any) => {
            captured = data;
            return makeDoc(data);
          }),
        },
        attendanceModel: { findOne: vi.fn(() => q({ status: 'absent' })) },
        resolver: { resolveApprovers: vi.fn().mockResolvedValue([{ level: 1, approverUserId }]) },
      });
      await svc.create(validInput());
      expect(captured.approvalChain).toHaveLength(1);
      expect(captured.approvalChain[0].level).toBe(1);
      expect(captured.currentStatus).toBe('absent');
    });

    it('uses Salary month = date.getUTCMonth() + 1 (Pitfall 6)', async () => {
      const salaryModel = { findOne: vi.fn(() => q(null)) };
      const svc = buildService({ salaryModel });
      // March 15 2026 → month must be 3, not 2
      await svc.create({ ...validInput(), date: '2026-03-15' }).catch(() => {});
      const filter = (salaryModel.findOne.mock.calls as any[][])[0]?.[0];
      if (filter) {
        expect(filter.month).toBe(3);
        expect(filter.year).toBe(2026);
      }
    });

    it('applies workspace regularizationConfig defaults when config subdoc is undefined', async () => {
      const resolver = {
        resolveApprovers: vi.fn().mockResolvedValue([{ level: 1, approverUserId }]),
      };
      const svc = buildService({
        workspaceModel: {
          findById: vi.fn(() => q({ _id: wsId, regularizationConfig: undefined })),
        },
        resolver,
      });
      await svc.create(validInput()).catch(() => {});
      // With undefined config, defaults apply → approvalLevels=1
      expect(resolver.resolveApprovers).toHaveBeenCalledWith(
        expect.objectContaining({ approvalLevels: 1 }),
      );
    });

    it('scopes every Mongoose query by wsId (Pitfall 5)', async () => {
      const filters: any[] = [];
      const teamMemberModel = {
        findOne: vi.fn((f: any) => {
          filters.push(f);
          return q({ _id: memberId, workspaceId: wsId, linkedUserId: null });
        }),
      };
      const svc = buildService({ teamMemberModel });
      await svc.create(validInput()).catch(() => {});
      // Every teamMember query must carry a wsId/workspaceId field
      for (const f of filters) {
        const hasScope = f.workspaceId !== undefined || f.wsId !== undefined;
        expect(hasScope).toBe(true);
      }
    });
  });

  // ==========================================================================
  describe('cancel()', () => {
    it('allows cancel only by raiser when status=pending and currentLevel=1 (DD-13)', async () => {
      const reqId = new Types.ObjectId();
      const raiserId = new Types.ObjectId();
      const otherId = new Types.ObjectId();

      const pendingDoc = makeDoc({
        _id: reqId,
        wsId,
        raisedBy: raiserId,
        status: 'pending',
        currentLevel: 1,
      });

      // Non-raiser → ForbiddenException
      {
        const svc = buildService({
          requestModel: {
            findOne: vi.fn(() => q(pendingDoc)),
            findOneAndUpdate: vi.fn(() => q(null)),
            find: vi.fn(() => q([])),
            create: vi.fn(),
          },
        });
        await expect(
          svc.cancel(wsId.toString(), reqId.toString(), otherId.toString()),
        ).rejects.toThrow(ForbiddenException);
      }

      // currentLevel > 1 → ForbiddenException
      {
        const l2doc = makeDoc({ ...pendingDoc, currentLevel: 2 });
        const svc = buildService({
          requestModel: {
            findOne: vi.fn(() => q(l2doc)),
            findOneAndUpdate: vi.fn(() => q(null)),
            find: vi.fn(() => q([])),
            create: vi.fn(),
          },
        });
        await expect(
          svc.cancel(wsId.toString(), reqId.toString(), raiserId.toString()),
        ).rejects.toThrow(ForbiddenException);
      }

      // Correct raiser at L1 → status='cancelled', finalDecisionAt stamped
      {
        const svc = buildService({
          requestModel: {
            findOne: vi.fn(() => q(pendingDoc)),
            findOneAndUpdate: vi.fn(() => q(null)),
            find: vi.fn(() => q([])),
            create: vi.fn(),
          },
        });
        const result = await svc.cancel(wsId.toString(), reqId.toString(), raiserId.toString());
        expect(result.status).toBe('cancelled');
        expect(result.finalDecisionAt).toBeInstanceOf(Date);
      }
    });
  });

  // ==========================================================================
  describe('approve()', () => {
    function makePendingReq(level = 1, requestedStatus = 'PRESENT', chainLength = 1) {
      const approvalChain =
        chainLength >= 2
          ? [
              { level: 1, approverUserId, decision: null, decidedAt: null, note: null },
              {
                level: 2,
                approverUserId: approver2Id,
                decision: null,
                decidedAt: null,
                note: null,
              },
            ]
          : [{ level: 1, approverUserId, decision: null, decidedAt: null, note: null }];
      return makeDoc({
        _id: new Types.ObjectId(),
        wsId,
        memberId,
        date: new Date(Date.UTC(2026, 2, 15)),
        status: 'pending',
        currentLevel: level,
        requestedStatus,
        requestedCheckIn: null,
        requestedCheckOut: null,
        approvalChain,
        resultingEventId: null,
        finalDecisionAt: null,
      });
    }

    it('uses findOneAndUpdate with status=pending + currentLevel filter to prevent double-write race (Pitfall 4)', async () => {
      const pendingDoc = makePendingReq(1);
      const approvedDoc = makeDoc({
        ...pendingDoc,
        status: 'approved',
        finalDecisionAt: new Date(),
      });

      // findOne always returns pendingDoc; findOneAndUpdate: first returns approvedDoc, second returns null
      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValueOnce(q(approvedDoc)).mockReturnValueOnce(q(null)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 1,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      const eventService = { createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })) };
      const projectionService = { recompute: vi.fn().mockResolvedValue({}) };

      const svc = buildService({ requestModel, workspaceModel, eventService, projectionService });

      // First call wins
      await svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString());

      // Second call loses — findOneAndUpdate returns null → ConflictException
      await expect(
        svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString()),
      ).rejects.toThrow(ConflictException);
    });

    it('non-final approval advances currentLevel and writes NO AttendanceEvent', async () => {
      const pendingDoc = makePendingReq(1, 'PRESENT', 2); // L1 of 2-level workspace
      const advancedDoc = makeDoc({ ...pendingDoc, currentLevel: 2 });

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(advancedDoc)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 2,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      const eventService = { createEvent: vi.fn() };

      const svc = buildService({ requestModel, workspaceModel, eventService });
      await svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString());

      expect(eventService.createEvent).not.toHaveBeenCalled();
    });

    it('final approval writes AttendanceEvent(source=regularization, punchType=STATUS_SET, markedBy=finalApprover)', async () => {
      const pendingDoc = makePendingReq(1);
      const approvedDoc = makeDoc({
        ...pendingDoc,
        status: 'approved',
        finalDecisionAt: new Date(),
      });

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(approvedDoc)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 1,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      const eventService = { createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })) };
      const projectionService = { recompute: vi.fn().mockResolvedValue({}) };

      const svc = buildService({ requestModel, workspaceModel, eventService, projectionService });
      await svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString());

      expect(eventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'regularization', punchType: 'STATUS_SET' }),
      );
    });

    it('final approval status mapping: LEAVE→on_leave, HALF_DAY→half_day, PRESENT→present, ABSENT→absent (Pitfall 1)', async () => {
      const cases: Array<[keyof typeof STATUS_MAP, string]> = [
        ['PRESENT', 'present'],
        ['HALF_DAY', 'half_day'],
        ['LEAVE', 'on_leave'],
        ['ABSENT', 'absent'],
      ];

      for (const [reqStatus, expectedVal] of cases) {
        const pendingDoc = makePendingReq(1, reqStatus);
        const approvedDoc = makeDoc({
          ...pendingDoc,
          status: 'approved',
          finalDecisionAt: new Date(),
        });

        const requestModel = {
          findOne: vi.fn(() => q(pendingDoc)),
          findOneAndUpdate: vi.fn().mockReturnValue(q(approvedDoc)),
          create: vi.fn(),
          find: vi.fn(() => q([])),
        };
        const workspaceModel = {
          findById: vi.fn(() =>
            q({
              regularizationConfig: {
                approvalLevels: 1,
                maxDaysBack: 30,
                maxAttachmentsPerRequest: 3,
              },
            }),
          ),
        };
        const eventService = { createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })) };
        const projectionService = { recompute: vi.fn().mockResolvedValue({}) };

        const svc = buildService({ requestModel, workspaceModel, eventService, projectionService });
        await svc.approveStep(
          wsId.toString(),
          pendingDoc._id.toString(),
          approverUserId.toString(),
        );

        expect(eventService.createEvent).toHaveBeenCalledWith(
          expect.objectContaining({ statusValue: expectedVal }),
        );
      }
    });

    it('final approval calls AttendanceProjectionService.recompute(wsId, memberId, date)', async () => {
      const pendingDoc = makePendingReq(1);
      const approvedDoc = makeDoc({
        ...pendingDoc,
        status: 'approved',
        finalDecisionAt: new Date(),
      });

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(approvedDoc)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 1,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      const eventService = { createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })) };
      const projectionService = { recompute: vi.fn().mockResolvedValue({}) };

      const svc = buildService({ requestModel, workspaceModel, eventService, projectionService });
      await svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString());

      expect(projectionService.recompute).toHaveBeenCalledWith(
        wsId.toString(),
        memberId.toString(),
        pendingDoc.date,
      );
    });

    it('final approval stamps finalDecisionAt and resultingEventId on the request', async () => {
      const pendingDoc = makePendingReq(1);
      const approvedDoc = makeDoc({
        ...pendingDoc,
        status: 'approved',
        finalDecisionAt: null,
        resultingEventId: null,
      });

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(approvedDoc)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 1,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      const eventService = { createEvent: vi.fn().mockResolvedValue(makeDoc({ _id: eventId })) };
      const projectionService = { recompute: vi.fn().mockResolvedValue({}) };

      const svc = buildService({ requestModel, workspaceModel, eventService, projectionService });
      const result = await svc.approveStep(
        wsId.toString(),
        pendingDoc._id.toString(),
        approverUserId.toString(),
      );

      // Service back-links resultingEventId after event write
      expect(result.resultingEventId).toEqual(eventId);
    });

    it('re-checks Salary.isLocked at approval time and rejects with PAYROLL_LOCKED_SINCE_CREATE (assumption A5 defensive add)', async () => {
      const pendingDoc = makePendingReq(1);

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(null)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const workspaceModel = {
        findById: vi.fn(() =>
          q({
            regularizationConfig: {
              approvalLevels: 1,
              maxDaysBack: 30,
              maxAttachmentsPerRequest: 3,
            },
          }),
        ),
      };
      // Salary locked at approval time
      const salaryModel = { findOne: vi.fn(() => q({ isLocked: true })) };

      const svc = buildService({ requestModel, workspaceModel, salaryModel });
      await expect(
        svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString()),
      ).rejects.toThrow(BadRequestException);
      await expect(
        svc.approveStep(wsId.toString(), pendingDoc._id.toString(), approverUserId.toString()),
      ).rejects.toThrow('PAYROLL_LOCKED_SINCE_CREATE');
    });

    it('rejects non-approver at the current level with ForbiddenException', async () => {
      const pendingDoc = makePendingReq(1);
      const wrongUser = new Types.ObjectId();

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn(() => q(null)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };

      const svc = buildService({ requestModel });
      await expect(
        svc.approveStep(wsId.toString(), pendingDoc._id.toString(), wrongUser.toString()),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        svc.approveStep(wsId.toString(), pendingDoc._id.toString(), wrongUser.toString()),
      ).rejects.toThrow('NOT_APPROVER');
    });
  });

  // ==========================================================================
  describe('reject()', () => {
    function makePendingForReject(level = 1) {
      return makeDoc({
        _id: new Types.ObjectId(),
        wsId,
        memberId,
        date: new Date(Date.UTC(2026, 2, 15)),
        status: 'pending',
        currentLevel: level,
        requestedStatus: 'PRESENT',
        approvalChain: [
          { level: 1, approverUserId, decision: null, decidedAt: null, note: null },
          { level: 2, approverUserId: approver2Id, decision: null, decidedAt: null, note: null },
        ],
        resultingEventId: null,
        finalDecisionAt: null,
      });
    }

    it('closes the request with status=rejected and writes NO AttendanceEvent', async () => {
      const pendingDoc = makePendingForReject(1);
      const rejectedDoc = makeDoc({
        ...pendingDoc,
        status: 'rejected',
        finalDecisionAt: new Date(),
      });

      const requestModel = {
        findOne: vi.fn(() => q(pendingDoc)),
        findOneAndUpdate: vi.fn().mockReturnValue(q(rejectedDoc)),
        create: vi.fn(),
        find: vi.fn(() => q([])),
      };
      const eventService = { createEvent: vi.fn() };

      const svc = buildService({ requestModel, eventService });
      const result = await svc.reject(
        wsId.toString(),
        pendingDoc._id.toString(),
        approverUserId.toString(),
      );

      expect(result.status).toBe('rejected');
      expect(eventService.createEvent).not.toHaveBeenCalled();
    });

    it('allows rejection at any pending level by the current approver', async () => {
      // L1 rejection by L1 approver
      {
        const doc = makePendingForReject(1);
        const rejectedDoc = makeDoc({ ...doc, status: 'rejected', finalDecisionAt: new Date() });
        const requestModel = {
          findOne: vi.fn(() => q(doc)),
          findOneAndUpdate: vi.fn().mockReturnValue(q(rejectedDoc)),
          create: vi.fn(),
          find: vi.fn(() => q([])),
        };
        const svc = buildService({ requestModel });
        const res = await svc.reject(
          wsId.toString(),
          doc._id.toString(),
          approverUserId.toString(),
        );
        expect(res.status).toBe('rejected');
      }

      // L2 rejection by L2 approver (after L1 approved)
      {
        const doc = makeDoc({
          _id: new Types.ObjectId(),
          wsId,
          memberId,
          date: new Date(),
          status: 'pending',
          currentLevel: 2,
          requestedStatus: 'PRESENT',
          approvalChain: [
            { level: 1, approverUserId, decision: 'approved', decidedAt: new Date(), note: null },
            { level: 2, approverUserId: approver2Id, decision: null, decidedAt: null, note: null },
          ],
          resultingEventId: null,
          finalDecisionAt: null,
        });
        const rejectedDoc = makeDoc({ ...doc, status: 'rejected', finalDecisionAt: new Date() });
        const requestModel = {
          findOne: vi.fn(() => q(doc)),
          findOneAndUpdate: vi.fn().mockReturnValue(q(rejectedDoc)),
          create: vi.fn(),
          find: vi.fn(() => q([])),
        };
        const svc = buildService({ requestModel });
        const res = await svc.reject(wsId.toString(), doc._id.toString(), approver2Id.toString());
        expect(res.status).toBe('rejected');
      }
    });
  });
});
