/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Step 6 — worker notifications on advance-request decisions.
 *
 * When an owner rejects an advance request, OR when an approved request is
 * disbursed (via SalaryService.approveAndDisburseAdvanceRequest, which calls the
 * `notifyAdvanceDisbursed` helper on this service), the worker who filed the
 * request is told in-app. The worker's recipient id is resolved from their
 * TeamMember.linkedUserId (a kiosk-only member with no app account is silently
 * skipped). Notification delivery is best-effort: a failure never blocks the
 * decision/disbursement (mirrors the leave-notification + ledger non-blocking
 * pattern).
 *
 * Links: advance-salary-request.service.ts reject / notifyAdvanceDisbursed,
 * leave-notification.service.ts fanOut (pattern copied),
 * team-member.schema.ts linkedUserId.
 *
 * The @nestjs/mongoose decorator mock must precede the service import so the
 * transitive schema @Prop/@Schema/@InjectModel decorations are no-ops under vitest.
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
import { AdvanceSalaryRequestService } from '../advance-salary-request.service';

const workspaceId = new Types.ObjectId().toHexString();
const requestObjId = new Types.ObjectId();
const memberObjId = new Types.ObjectId();
const linkedUserObjId = new Types.ObjectId();
const reviewerUserId = new Types.ObjectId().toHexString();

/** A team-member lookup that returns the given linkedUserId (or none). */
function teamMemberModelWith(linkedUserId: Types.ObjectId | undefined) {
  return {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi
            .fn()
            .mockResolvedValue(linkedUserId ? { linkedUserId } : { linkedUserId: undefined }),
        }),
      }),
    }),
  };
}

function pendingRequestDoc() {
  const doc: any = {
    _id: requestObjId,
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId: memberObjId,
    month: 6,
    year: 2026,
    requestedAmount: 50000,
    approvedAmount: undefined,
    status: 'pending',
  };
  doc.save = vi.fn().mockResolvedValue(doc);
  return doc;
}

function buildService(
  opts: {
    requestDoc?: any;
    linkedUserId?: Types.ObjectId;
    createNotification?: any;
  } = {},
) {
  const requestDoc = opts.requestDoc ?? pendingRequestDoc();
  const advanceRequestModel: any = {
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
  };
  const payrollConfigModel: any = {};
  const createNotification = opts.createNotification ?? vi.fn().mockResolvedValue({});
  const notificationsService: any = { createNotification };
  const teamMemberModel = teamMemberModelWith(
    'linkedUserId' in opts ? opts.linkedUserId : linkedUserObjId,
  );

  const service = new AdvanceSalaryRequestService(
    advanceRequestModel,
    payrollConfigModel,
    notificationsService,
    teamMemberModel as any,
  );

  return { service, advanceRequestModel, notificationsService, createNotification, requestDoc };
}

describe('AdvanceSalaryRequestService.reject — worker notification', () => {
  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    ctx = buildService();
  });

  it('notifies the worker (resolved from linkedUserId) that the request was declined', async () => {
    await ctx.service.reject(workspaceId, requestObjId.toHexString(), reviewerUserId, {
      reviewNote: 'Not this month',
    });

    expect(ctx.createNotification).toHaveBeenCalledTimes(1);
    expect(ctx.createNotification).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        recipientId: linkedUserObjId.toString(),
        type: 'warning',
        metadata: expect.objectContaining({
          entityType: 'advance_request',
          entityId: requestObjId.toString(),
        }),
      }),
    );
  });

  it('still returns the rejected request when the member has no linked user account', async () => {
    ctx = buildService({ linkedUserId: undefined });
    const result = await ctx.service.reject(
      workspaceId,
      requestObjId.toHexString(),
      reviewerUserId,
      {},
    );

    expect(result.status).toBe('rejected');
    expect(ctx.createNotification).not.toHaveBeenCalled();
  });

  it('swallows a notification failure and still completes the rejection', async () => {
    ctx = buildService({ createNotification: vi.fn().mockRejectedValue(new Error('notify down')) });
    const result = await ctx.service.reject(
      workspaceId,
      requestObjId.toHexString(),
      reviewerUserId,
      {},
    );

    expect(result.status).toBe('rejected');
  });
});

describe('AdvanceSalaryRequestService.notifyAdvanceDisbursed', () => {
  it('notifies the worker that the advance was approved', async () => {
    const { service, createNotification } = buildService();
    const request: any = {
      _id: requestObjId,
      teamMemberId: memberObjId,
      month: 6,
      year: 2026,
      approvedAmount: 30000,
      requestedAmount: 50000,
    };

    await service.notifyAdvanceDisbursed(workspaceId, request, reviewerUserId);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        recipientId: linkedUserObjId.toString(),
        type: 'success',
        metadata: expect.objectContaining({
          entityType: 'advance_request',
          entityId: requestObjId.toString(),
        }),
      }),
    );
  });

  it('no-ops without throwing when the member has no linked user account', async () => {
    const { service, createNotification } = buildService({ linkedUserId: undefined });
    const request: any = {
      _id: requestObjId,
      teamMemberId: memberObjId,
      month: 6,
      year: 2026,
      approvedAmount: 30000,
    };

    await expect(
      service.notifyAdvanceDisbursed(workspaceId, request, reviewerUserId),
    ).resolves.toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
