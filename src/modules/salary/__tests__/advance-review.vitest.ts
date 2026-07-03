/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 3a — reporting-person advance review (service layer).
 *
 * A member's reporting person (their TeamMember.reportsTo manager, holding
 * salary.review_advance) can SEE and VERIFY their direct reports' advance
 * requests. Verify is ADVISORY: it stamps verifiedBy/verifiedAt/verifyNote and
 * NEVER changes request.status nor blocks the owner approve/reject/pay path.
 *
 * Anti-fraud guards covered here:
 *   - listForMyReports returns ONLY requests whose member's reportsTo == reviewer
 *     (and [] when the reviewer has no direct reports).
 *   - verifyRequest stamps the three advisory fields.
 *   - verifyRequest THROWS Forbidden when the reviewer verifies their OWN request
 *     (separation of duties).
 *   - verifyRequest THROWS Forbidden when the target's member.reportsTo is NOT the
 *     reviewer (not your direct report).
 *
 * The @nestjs/mongoose decorator mock must precede the service import so the
 * transitive schema @Prop/@Schema/@InjectModel decorations are no-ops under vitest.
 * Links: advance-salary-request.service.ts listForMyReports / verifyRequest.
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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdvanceSalaryRequestService } from '../advance-salary-request.service';

const workspaceId = new Types.ObjectId().toHexString();
const reviewerTeamMemberId = new Types.ObjectId();
const reviewerUserId = new Types.ObjectId().toHexString();
const reportMemberA = new Types.ObjectId();
const reportMemberB = new Types.ObjectId();
const requestObjId = new Types.ObjectId();

/**
 * Build a teamMemberModel mock with two chainable surfaces:
 *   - find().distinct('_id')          -> resolves `distinctIds` (the report ids)
 *   - findById(id)                    -> resolves `memberDoc` (reportsTo lookup)
 */
function teamMemberModelMock(opts: { distinctIds?: Types.ObjectId[]; memberDoc?: any } = {}) {
  return {
    find: vi.fn().mockReturnValue({
      distinct: vi.fn().mockResolvedValue(opts.distinctIds ?? []),
    }),
    findById: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(opts.memberDoc ?? null),
      }),
    }),
  };
}

function buildService(opts: {
  distinctIds?: Types.ObjectId[];
  listRows?: any[];
  requestDoc?: any;
  memberDoc?: any;
}) {
  const listRows = opts.listRows ?? [];
  const advanceRequestModel: any = {
    // listForMyReports: find(...).sort(...).lean().exec()
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(listRows),
        }),
      }),
    }),
    // verifyRequest: findOne(...).exec()
    findOne: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(opts.requestDoc ?? null),
    }),
  };
  const payrollConfigModel: any = {};
  const notificationsService: any = { createNotification: vi.fn().mockResolvedValue({}) };
  const teamMemberModel = teamMemberModelMock({
    distinctIds: opts.distinctIds,
    memberDoc: opts.memberDoc,
  });

  const service = new AdvanceSalaryRequestService(
    advanceRequestModel,
    payrollConfigModel,
    notificationsService,
    teamMemberModel as any,
  );
  return { service, advanceRequestModel, teamMemberModel };
}

describe('AdvanceSalaryRequestService.listForMyReports', () => {
  it('returns only the requests of members who report to the reviewer', async () => {
    const rows = [
      { _id: requestObjId, teamMemberId: reportMemberA, status: 'pending' },
      { _id: new Types.ObjectId(), teamMemberId: reportMemberB, status: 'pending' },
    ];
    const { service, teamMemberModel, advanceRequestModel } = buildService({
      distinctIds: [reportMemberA, reportMemberB],
      listRows: rows,
    });

    const result = await service.listForMyReports(workspaceId, reviewerTeamMemberId.toHexString());

    expect(result).toEqual(rows);
    // reports are resolved by reportsTo == reviewer
    expect(teamMemberModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ reportsTo: expect.anything() }),
    );
    // requests are filtered to the report ids
    expect(advanceRequestModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ teamMemberId: { $in: [reportMemberA, reportMemberB] } }),
    );
  });

  it('returns [] (no DB request query) when the reviewer has no direct reports', async () => {
    const { service, advanceRequestModel } = buildService({ distinctIds: [], listRows: [] });

    const result = await service.listForMyReports(workspaceId, reviewerTeamMemberId.toHexString());

    expect(result).toEqual([]);
    expect(advanceRequestModel.find).not.toHaveBeenCalled();
  });
});

describe('AdvanceSalaryRequestService.verifyRequest', () => {
  function requestDocFor(teamMemberId: Types.ObjectId) {
    const doc: any = {
      _id: requestObjId,
      workspaceId: new Types.ObjectId(workspaceId),
      teamMemberId,
      status: 'pending',
      verifiedBy: undefined,
      verifiedAt: undefined,
      verifyNote: undefined,
    };
    // save() returns the (mutated) doc so the service's `return request.save()`
    // surfaces the stamped advisory fields.
    doc.save = vi.fn().mockResolvedValue(doc);
    return doc;
  }

  it('stamps verifiedBy/verifiedAt/verifyNote without changing status (advisory)', async () => {
    const requestDoc = requestDocFor(reportMemberA);
    const { service } = buildService({
      requestDoc,
      memberDoc: { _id: reportMemberA, reportsTo: reviewerTeamMemberId },
    });

    const result = await service.verifyRequest(
      workspaceId,
      requestObjId.toHexString(),
      reviewerUserId,
      reviewerTeamMemberId.toHexString(),
      'Looks genuine, approve',
    );

    expect(String(result.verifiedBy)).toBe(reviewerUserId);
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(result.verifyNote).toBe('Looks genuine, approve');
    // ADVISORY — never touches status
    expect(result.status).toBe('pending');
    expect(requestDoc.save).toHaveBeenCalledTimes(1);
  });

  it('throws NotFound when the request does not exist in the workspace', async () => {
    const { service } = buildService({ requestDoc: null });

    await expect(
      service.verifyRequest(
        workspaceId,
        requestObjId.toHexString(),
        reviewerUserId,
        reviewerTeamMemberId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws Forbidden when the reviewer verifies their OWN request (SoD)', async () => {
    // The request belongs to the reviewer's OWN team-member id.
    const requestDoc = requestDocFor(reviewerTeamMemberId);
    const { service } = buildService({
      requestDoc,
      memberDoc: { _id: reviewerTeamMemberId, reportsTo: reviewerTeamMemberId },
    });

    await expect(
      service.verifyRequest(
        workspaceId,
        requestObjId.toHexString(),
        reviewerUserId,
        reviewerTeamMemberId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(requestDoc.save).not.toHaveBeenCalled();
  });

  it("throws Forbidden when the target's reportsTo is NOT the reviewer", async () => {
    const requestDoc = requestDocFor(reportMemberA);
    const someoneElse = new Types.ObjectId();
    const { service } = buildService({
      requestDoc,
      // member A reports to someone OTHER than the reviewer
      memberDoc: { _id: reportMemberA, reportsTo: someoneElse },
    });

    await expect(
      service.verifyRequest(
        workspaceId,
        requestObjId.toHexString(),
        reviewerUserId,
        reviewerTeamMemberId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(requestDoc.save).not.toHaveBeenCalled();
  });

  it('throws Forbidden when the target member has no reportsTo at all', async () => {
    const requestDoc = requestDocFor(reportMemberA);
    const { service } = buildService({
      requestDoc,
      memberDoc: { _id: reportMemberA, reportsTo: null },
    });

    await expect(
      service.verifyRequest(
        workspaceId,
        requestObjId.toHexString(),
        reviewerUserId,
        reviewerTeamMemberId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
