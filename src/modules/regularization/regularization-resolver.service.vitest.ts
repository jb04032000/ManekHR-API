import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { RegularizationResolverService } from './regularization-resolver.service';

/**
 * In-memory TeamMember fixture. Each entry is keyed by the _id string.
 * The mocked model handles findOne({ _id, workspaceId }) by looking up by _id and
 * asserting the workspaceId matches.
 */
interface FakeMember {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  reportsTo: Types.ObjectId | null;
  linkedUserId: Types.ObjectId | null;
}

function makeModel(
  members: Map<string, FakeMember>,
  queryAudit: Array<Record<string, unknown>>,
) {
  return {
    findOne: vi.fn((filter: Record<string, unknown>) => {
      queryAudit.push(filter); // for Pitfall 5 wsId-scope test
      const id = String(filter._id);
      const hit = members.get(id);
      const wsMatches =
        hit && filter.workspaceId?.toString() === hit.workspaceId.toString();
      const doc = wsMatches ? hit : null;
      return {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(doc),
      };
    }),
  };
}

describe('RegularizationResolverService', () => {
  const wsId = new Types.ObjectId();
  const A = new Types.ObjectId(); // requester
  const B = new Types.ObjectId(); // A's manager
  const C = new Types.ObjectId(); // B's manager
  const Buser = new Types.ObjectId();
  const Cuser = new Types.ObjectId();
  const F = new Types.ObjectId(); // fallback user
  const Bnoop = new Types.ObjectId(); // manager w/ no linkedUserId

  let members: Map<string, FakeMember>;
  let queryAudit: Array<Record<string, unknown>>;
  let svc: RegularizationResolverService;

  beforeEach(() => {
    members = new Map();
    queryAudit = [];
    const model = makeModel(members, queryAudit);
    svc = new RegularizationResolverService(model as any);
  });

  const put = (m: FakeMember) => members.set(m._id.toString(), m);

  it('walks reportsTo chain up to approvalLevels when the chain is long enough', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: B, linkedUserId: null });
    put({ _id: B, workspaceId: wsId, reportsTo: C, linkedUserId: Buser });
    put({ _id: C, workspaceId: wsId, reportsTo: null, linkedUserId: Cuser });
    const chain = await svc.resolveApprovers({
      wsId: wsId.toString(),
      memberId: A.toString(),
      approvalLevels: 2,
      fallbackApproverUserId: null,
    });
    expect(chain).toHaveLength(2);
    expect(chain[0].level).toBe(1);
    expect(chain[0].approverUserId.toString()).toBe(Buser.toString());
    expect(chain[1].level).toBe(2);
    expect(chain[1].approverUserId.toString()).toBe(Cuser.toString());
  });

  it('fills missing levels from fallbackApprover when chain shorter than approvalLevels', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: B, linkedUserId: null });
    put({ _id: B, workspaceId: wsId, reportsTo: null, linkedUserId: Buser });
    const chain = await svc.resolveApprovers({
      wsId: wsId.toString(),
      memberId: A.toString(),
      approvalLevels: 3,
      fallbackApproverUserId: F.toString(),
    });
    expect(chain.map((c) => c.approverUserId.toString())).toEqual([
      Buser.toString(),
      F.toString(),
      F.toString(),
    ]);
  });

  it('throws BadRequestException when chain is short AND fallbackApprover is null', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: null, linkedUserId: null });
    await expect(
      svc.resolveApprovers({
        wsId: wsId.toString(),
        memberId: A.toString(),
        approvalLevels: 2,
        fallbackApproverUserId: null,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('detects reportsTo cycle and aborts without looping (Pitfall 3)', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: B, linkedUserId: null });
    put({ _id: B, workspaceId: wsId, reportsTo: A, linkedUserId: Buser }); // cycle
    const chain = await svc.resolveApprovers({
      wsId: wsId.toString(),
      memberId: A.toString(),
      approvalLevels: 2,
      fallbackApproverUserId: F.toString(),
    });
    expect(chain.map((c) => c.approverUserId.toString())).toEqual([
      Buser.toString(),
      F.toString(),
    ]);
  });

  it('skips managers whose linkedUserId is null and lets fallback fill', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: Bnoop, linkedUserId: null });
    put({ _id: Bnoop, workspaceId: wsId, reportsTo: C, linkedUserId: null }); // no login
    put({ _id: C, workspaceId: wsId, reportsTo: null, linkedUserId: Cuser });
    const chain = await svc.resolveApprovers({
      wsId: wsId.toString(),
      memberId: A.toString(),
      approvalLevels: 2,
      fallbackApproverUserId: F.toString(),
    });
    // Chain breaks at Bnoop; fallback fills both levels.
    expect(chain.map((c) => c.approverUserId.toString())).toEqual([
      F.toString(),
      F.toString(),
    ]);
  });

  it('workspace-scopes every TeamMember query by wsId (Pitfall 5)', async () => {
    put({ _id: A, workspaceId: wsId, reportsTo: B, linkedUserId: null });
    put({ _id: B, workspaceId: wsId, reportsTo: null, linkedUserId: Buser });
    await svc.resolveApprovers({
      wsId: wsId.toString(),
      memberId: A.toString(),
      approvalLevels: 1,
      fallbackApproverUserId: null,
    });
    // Every findOne invocation must include workspaceId in filter
    expect(queryAudit.length).toBeGreaterThan(0);
    for (const q of queryAudit) {
      expect(q.workspaceId).toBeDefined();
      expect(q.workspaceId!.toString()).toBe(wsId.toString());
    }
  });
});
