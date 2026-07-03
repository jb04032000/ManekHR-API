/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Neutralise @nestjs/mongoose decorators before the controller (and its
// transitive schema graph) is imported.
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
import { LeaveController } from '../leave.controller';
import {
  CallerScopeService,
  type CallerScopeContext,
} from '../../../common/services/caller-scope.service';

/**
 * G2 (2026-05-24) — leave self/all scope now resolves against the PATH store
 * the guard enforces on. A path-only (override) `self` grant must pin reads +
 * applies to the caller's own row, even when a spoofed `memberId` is supplied.
 *
 * Pre-G2 (flat `effectiveScope`) this grant resolved to `null`: `selfScoped`
 * was false, so a supplied `memberId` flowed straight through — a self-scoped
 * worker could read another member's balances or apply on their behalf.
 */
describe('LeaveController — G2 path-scope self-narrowing', () => {
  const wsId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const ownMemberId = new Types.ObjectId().toHexString();
  const otherMemberId = new Types.ObjectId().toHexString();

  let callerScope: CallerScopeService;
  let ledgerService: any;
  let requestService: any;
  let notificationService: any;
  let controller: LeaveController;

  const pathOnlySelfCtx = (path: string): CallerScopeContext => ({
    isOwner: false,
    teamMemberId: ownMemberId,
    permissions: [],
    permissionPaths: [{ path, scope: 'self' as const }],
  });

  beforeEach(() => {
    callerScope = new CallerScopeService({} as never);
    ledgerService = { getBalances: vi.fn().mockResolvedValue([]) };
    requestService = {
      applyForLeave: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    notificationService = { leaveApplied: vi.fn().mockResolvedValue(undefined) };

    controller = new LeaveController(
      {} as any, // leaveService
      requestService, // requestService
      ledgerService, // ledgerService
      {} as any, // settingsService
      callerScope, // callerScope
      notificationService, // notificationService
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('balances: a path-only self grant narrows to the caller own row, ignoring a spoofed query memberId', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue(pathOnlySelfCtx('leave.balance.view'));

    await controller.balances(
      wsId,
      { memberId: otherMemberId, year: 2026 },
      {
        user: { sub: userId },
      },
    );

    expect(ledgerService.getBalances).toHaveBeenCalledTimes(1);
    // getBalances(wsObjId, memberObjId, year) — the member arg must be OWN.
    const memberArg = ledgerService.getBalances.mock.calls[0][1];
    expect(String(memberArg)).toBe(ownMemberId);
  });

  it('apply: a path-only self grant forces the own member id and selfScoped=true', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue(pathOnlySelfCtx('leave.request.apply'));

    await controller.apply(
      wsId,
      {
        memberId: otherMemberId,
        leaveTypeId: new Types.ObjectId().toHexString(),
        fromDate: '2026-05-20',
        toDate: '2026-05-21',
      },
      { user: { sub: userId } },
    );

    expect(requestService.applyForLeave).toHaveBeenCalledTimes(1);
    const arg = requestService.applyForLeave.mock.calls[0][0];
    expect(String(arg.teamMemberId)).toBe(ownMemberId);
    expect(arg.selfScoped).toBe(true);
  });
});
