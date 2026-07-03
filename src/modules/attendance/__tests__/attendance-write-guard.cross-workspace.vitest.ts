/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Cross-workspace isolation — AttendanceWriteGuardService (Attendance hardening,
 * 2026-06-15).
 *
 * Mirrors salary-write-guard.cross-workspace.vitest.ts exactly.
 *
 * AC-2.10 / AC-2.11 — the write guard uses BOTH workspaceId AND _id in its
 * TeamMember lookup, so a member who exists in workspace-A is invisible to the
 * guard when called with workspace-B's ID. The lookup returns null and the write
 * is blocked with MEMBER_OFFBOARDED (fail-closed) rather than opening the write
 * path for a cross-workspace target.
 *
 * Also asserts: the SoD self-edit check (assertNotSelfAttendanceEdit) resolves
 * the caller's member ID via callerScope.resolve, which is called with the
 * request's workspaceId — so the identity resolved for WS-B cannot leak WS-A
 * member IDs.
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

import { ForbiddenException } from '@nestjs/common';
import { AttendanceWriteGuardService } from '../attendance-write-guard.service';

// Valid 24-hex ObjectId strings for two distinct workspaces + a member + a user.
const WS_A = '5f8d04b3b54764421b7156aa';
const WS_B = '5f8d04b3b54764421b7156bb';
const TM1 = '5f8d04b3b54764421b7156c1';
const USER1 = '5f8d04b3b54764421b7156d1';

/**
 * Build a service whose TeamMember model returns a non-deleted member ONLY
 * when the query workspaceId matches `visibleInWs`. Any other workspace ID
 * produces a null result (member does not exist in that workspace).
 */
function makeService(opts: { visibleInWs: string }) {
  const teamModel = {
    findOne: vi.fn().mockImplementation((filter: any) => {
      const wsMatch = String(filter.workspaceId) === opts.visibleInWs;
      const memberDoc = wsMatch ? { _id: TM1, isDeleted: false } : null;
      return {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(memberDoc),
      };
    }),
  };

  const callerScope = {
    resolve: vi.fn().mockResolvedValue({ isOwner: false, teamMemberId: TM1 }),
  };

  const service = new AttendanceWriteGuardService(teamModel as any, callerScope as any);
  return { service, teamModel, callerScope };
}

describe('AttendanceWriteGuardService — cross-workspace isolation (AC-2.10 / AC-2.11)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assertMemberWritable: permits a write when member exists in the correct workspace', async () => {
    const { service } = makeService({ visibleInWs: WS_A });
    await expect(service.assertMemberWritable(WS_A, TM1)).resolves.toBeUndefined();
  });

  it('assertMemberWritable: blocks when the lookup workspaceId is WS-B and member is WS-A only', async () => {
    // Member exists in WS_A; write attempted with WS_B -> null lookup -> fail-closed 403.
    const { service } = makeService({ visibleInWs: WS_A });
    await expect(service.assertMemberWritable(WS_B, TM1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('assertMemberWritable: the fail-closed WS-B error carries MEMBER_OFFBOARDED code', async () => {
    const { service } = makeService({ visibleInWs: WS_A });
    await expect(service.assertMemberWritable(WS_B, TM1)).rejects.toMatchObject({
      response: { code: 'MEMBER_OFFBOARDED' },
    });
  });

  it('assertMemberWritable: the findOne filter always carries workspaceId', async () => {
    const { service, teamModel } = makeService({ visibleInWs: WS_A });
    await service.assertMemberWritable(WS_A, TM1).catch(() => undefined);
    const callFilter = teamModel.findOne.mock.calls[0][0];
    // Both workspaceId AND _id must be in the filter — cross-workspace ID cannot match.
    expect(callFilter).toHaveProperty('workspaceId');
    expect(callFilter).toHaveProperty('_id');
  });

  it('assertNotSelfAttendanceEdit: resolves scope via callerScope using the provided workspaceId', async () => {
    const { service, callerScope } = makeService({ visibleInWs: WS_A });
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: TM1 });

    // Self-edit blocked (caller is the target member in WS_A).
    await expect(service.assertNotSelfAttendanceEdit(WS_A, USER1, TM1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // callerScope.resolve was called with the right workspace.
    expect(callerScope.resolve).toHaveBeenCalledWith(WS_A, USER1);
  });

  it('assertNotSelfAttendanceEdit: calling with WS_B does not leak WS_A member identity', async () => {
    // Even if somehow the caller's WS_A teamMemberId matches TM1, the scope
    // service is called with WS_B's ID, so it resolves the WS_B identity.
    const { service, callerScope } = makeService({ visibleInWs: WS_A });
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: 'different-member' });

    // Caller's WS_B member != TM1, so no SoD block fires.
    await expect(service.assertNotSelfAttendanceEdit(WS_B, USER1, TM1)).resolves.toBeUndefined();
    expect(callerScope.resolve).toHaveBeenCalledWith(WS_B, USER1);
  });

  it('assertMemberWritable: a soft-deleted member in WS_A is still blocked even when workspace matches', async () => {
    // Simulate a member that IS in the right workspace but isDeleted=true.
    const teamModel = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({ _id: TM1, isDeleted: true }),
      }),
    };
    const callerScope = { resolve: vi.fn() };
    const service = new AttendanceWriteGuardService(teamModel as any, callerScope as any);

    await expect(service.assertMemberWritable(WS_A, TM1)).rejects.toMatchObject({
      response: { code: 'MEMBER_OFFBOARDED' },
    });
  });
});
