/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Cross-workspace isolation — SalaryWriteGuardService (Workstream G, 2026-06-14).
 *
 * AC-2.9 / Pillar 2 cross-workspace isolation. The write guard uses BOTH
 * workspaceId AND _id in its TeamMember lookup, so a member who exists in
 * workspace-A is invisible to the guard when it is called with workspace-B's
 * ID — the lookup returns null and the write is blocked with MEMBER_OFFBOARDED
 * (fail-closed) rather than accidentally opening the write path.
 *
 * This test asserts:
 *   1. The TeamMember findOne query always carries workspaceId in the filter.
 *   2. A member present in WS-A is rejected (null result) when the write is
 *      attempted with WS-B — exactly as a missing member row.
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
import { SalaryWriteGuardService } from '../salary-write-guard.service';

// Valid 24-hex ObjectId strings for two distinct workspaces + a member.
const WS_A = '5f8d04b3b54764421b7156aa';
const WS_B = '5f8d04b3b54764421b7156bb';
const TM1 = '5f8d04b3b54764421b7156c1';
const USER1 = '5f8d04b3b54764421b7156d1';

/**
 * Build a service whose TeamMember model returns a non-deleted member ONLY
 * when the query workspaceId matches `visibleInWs`. For any other workspace
 * the model returns null (member does not exist in that workspace).
 */
function makeService(opts: { visibleInWs: string }) {
  const teamModel = {
    findOne: vi.fn().mockImplementation((filter: any) => {
      // Simulate DB workspace-scoped lookup:
      // The member only exists in `visibleInWs`.
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
    resolve: vi.fn().mockResolvedValue({
      isOwner: false,
      teamMemberId: TM1,
    }),
  };

  const service = new SalaryWriteGuardService(teamModel as any, callerScope as any);
  return { service, teamModel, callerScope };
}

describe('SalaryWriteGuardService — cross-workspace isolation (AC-2.9)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assertMemberWritable: permits a write when member exists in the correct workspace', async () => {
    const { service } = makeService({ visibleInWs: WS_A });
    await expect(service.assertMemberWritable(WS_A, TM1)).resolves.toBeUndefined();
  });

  it('assertMemberWritable: blocks when the lookup workspaceId is workspace-B and member is WS-A only', async () => {
    // Member exists in WS_A; write attempted in WS_B -> null row -> fail-closed 403.
    const { service } = makeService({ visibleInWs: WS_A });
    await expect(service.assertMemberWritable(WS_B, TM1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('assertMemberWritable: the findOne filter always carries workspaceId', async () => {
    const { service, teamModel } = makeService({ visibleInWs: WS_A });
    await service.assertMemberWritable(WS_A, TM1).catch(() => undefined);
    const callFilter = teamModel.findOne.mock.calls[0][0];
    // The filter must scope by workspaceId so a cross-workspace ID cannot match.
    expect(callFilter).toHaveProperty('workspaceId');
    expect(callFilter).toHaveProperty('_id');
  });

  it('assertNotSelfSalaryEdit: resolves scope via callerScope using the provided workspaceId', async () => {
    const { service, callerScope } = makeService({ visibleInWs: WS_A });
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: TM1 });

    // Self-edit blocked (caller is the target member in WS_A).
    await expect(service.assertNotSelfSalaryEdit(WS_A, USER1, TM1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // callerScope.resolve was called with the right workspace.
    expect(callerScope.resolve).toHaveBeenCalledWith(WS_A, USER1);
  });

  it('assertNotSelfSalaryEdit: calling with WS_B does not leak WS_A member identity', async () => {
    // Even if somehow a caller's teamMemberId matched a WS_A member ID,
    // the scope service (called with WS_B) must be what resolves the memberId.
    // This test confirms the workspace arg is forwarded to callerScope.resolve.
    const { service, callerScope } = makeService({ visibleInWs: WS_A });
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: 'different-member' });

    // No self-edit (caller's WS_B member != TM1).
    await expect(service.assertNotSelfSalaryEdit(WS_B, USER1, TM1)).resolves.toBeUndefined();
    expect(callerScope.resolve).toHaveBeenCalledWith(WS_B, USER1);
  });
});
