/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Security regression: advance-request creation must be bound to the caller's
 * OWN team-member record (IDOR fix). The create endpoint previously trusted a
 * `teamMemberId` supplied in the request body, which let a self-scoped worker
 * file an advance request on another member's behalf. The controller now
 * resolves the caller's own teamMemberId via CallerScopeService (mirroring the
 * GET /mine route) and the request body no longer carries a member id.
 *
 * Links: advance-salary-request.controller.ts (createRequest) ->
 * CallerScopeService.resolve; advance-salary-request.service.ts (createRequest).
 *
 * The @nestjs/mongoose decorator mock must precede the controller import so the
 * transitive schema @Prop/@Schema/@InjectModel decorations reachable through
 * AdvanceSalaryRequestService are treated as no-ops under vitest.
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

import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdvanceSalaryRequestController } from '../advance-salary-request.controller';

const workspaceId = new Types.ObjectId().toHexString();
const userId = new Types.ObjectId().toHexString();

describe('AdvanceSalaryRequestController.createRequest — self-bind (IDOR fix)', () => {
  it("binds the request to the caller's own resolved teamMemberId, not a body value", async () => {
    const callerMemberId = new Types.ObjectId().toHexString();
    const service = { createRequest: vi.fn().mockResolvedValue({ _id: 'r1' }) };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: callerMemberId }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    await controller.createRequest(
      workspaceId,
      { user: { sub: userId } } as any,
      { requestedAmount: 5000, month: 6, year: 2026 } as any,
    );

    expect(callerScope.resolve).toHaveBeenCalledWith(workspaceId, userId);
    expect(service.createRequest).toHaveBeenCalledWith(
      workspaceId,
      userId,
      callerMemberId,
      expect.objectContaining({ requestedAmount: 5000, month: 6, year: 2026 }),
    );
  });

  it('throws Forbidden and never calls the service when the caller has no team-member record', async () => {
    const service = { createRequest: vi.fn() };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: null }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    await expect(
      controller.createRequest(workspaceId, { user: { sub: userId } } as any, {} as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.createRequest).not.toHaveBeenCalled();
  });
});

describe('AdvanceSalaryRequestController — reporting-person review (Phase 3a)', () => {
  it("listForMyReports resolves the caller's teamMemberId and delegates to the service", async () => {
    const callerMemberId = new Types.ObjectId().toHexString();
    const service = { listForMyReports: vi.fn().mockResolvedValue([{ _id: 'r1' }]) };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: callerMemberId }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    const result = await controller.listForMyReports(workspaceId, {
      user: { sub: userId },
    } as any);

    expect(callerScope.resolve).toHaveBeenCalledWith(workspaceId, userId);
    expect(service.listForMyReports).toHaveBeenCalledWith(workspaceId, callerMemberId);
    expect(result).toEqual([{ _id: 'r1' }]);
  });

  it('listForMyReports throws Forbidden when the caller has no team-member record', async () => {
    const service = { listForMyReports: vi.fn() };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: null }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    await expect(
      controller.listForMyReports(workspaceId, { user: { sub: userId } } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.listForMyReports).not.toHaveBeenCalled();
  });

  it("verify resolves the caller's teamMemberId and forwards the optional note", async () => {
    const callerMemberId = new Types.ObjectId().toHexString();
    const requestId = new Types.ObjectId().toHexString();
    const service = { verifyRequest: vi.fn().mockResolvedValue({ _id: requestId }) };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: callerMemberId }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    await controller.verify(
      workspaceId,
      requestId,
      { user: { sub: userId } } as any,
      {
        note: 'verified',
      } as any,
    );

    expect(callerScope.resolve).toHaveBeenCalledWith(workspaceId, userId);
    expect(service.verifyRequest).toHaveBeenCalledWith(
      workspaceId,
      requestId,
      userId,
      callerMemberId,
      'verified',
    );
  });

  it('verify throws Forbidden when the caller has no team-member record', async () => {
    const requestId = new Types.ObjectId().toHexString();
    const service = { verifyRequest: vi.fn() };
    const callerScope = { resolve: vi.fn().mockResolvedValue({ teamMemberId: null }) };
    const controller = new AdvanceSalaryRequestController(
      service as any,
      {} as any,
      callerScope as any,
    );

    await expect(
      controller.verify(workspaceId, requestId, { user: { sub: userId } } as any, {} as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.verifyRequest).not.toHaveBeenCalled();
  });
});
