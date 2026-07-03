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
import { RegularizationController } from '../regularization.controller';
import {
  CallerScopeService,
  type CallerScopeContext,
} from '../../../common/services/caller-scope.service';

/**
 * G2 (2026-05-24) — regularization `create` previously resolved scope from the
 * flat `AppModule.ATTENDANCE / MANAGE_REGULARIZATIONS` grant, while the guard
 * admits on the path `regularization.request.apply`. For a path-only (override)
 * self grant the flat lookup returned `null` → `selfScoped` false → a supplied
 * `memberId` flowed through, letting a worker raise a correction against
 * another member. The swap to `effectivePathScope('regularization.request.apply')`
 * pins the request to the caller's own row.
 */
describe('RegularizationController — G2 path-scope self-narrowing', () => {
  const wsId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const ownMemberId = new Types.ObjectId().toHexString();
  const otherMemberId = new Types.ObjectId().toHexString();

  let callerScope: CallerScopeService;
  let service: any;
  let controller: RegularizationController;

  const pathOnlySelfCtx = (path: string): CallerScopeContext => ({
    isOwner: false,
    teamMemberId: ownMemberId,
    permissions: [],
    permissionPaths: [{ path, scope: 'self' as const }],
  });

  beforeEach(() => {
    callerScope = new CallerScopeService({} as never);
    service = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      notifyNewApprover: vi.fn().mockResolvedValue(undefined),
    };
    controller = new RegularizationController(service, callerScope);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('create: a path-only self grant raises the correction against the caller own row only', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue(
      pathOnlySelfCtx('regularization.request.apply'),
    );

    await controller.create(
      wsId,
      {
        memberId: otherMemberId,
        date: '2026-04-15',
        requestedStatus: 'PRESENT',
        reason: 'machine missed the punch',
      } as any,
      { user: { sub: userId } },
    );

    expect(service.create).toHaveBeenCalledTimes(1);
    const arg = service.create.mock.calls[0][0];
    expect(arg.memberId).toBe(ownMemberId);
    expect(arg.selfScoped).toBe(true);
  });
});
