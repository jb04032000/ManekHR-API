/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AdminService so transitive
// decorated schema imports do not trip vitest's reflect-metadata pipeline.
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
vi.mock('../../subscriptions/subscriptions.service', () => ({ SubscriptionsService: class {} }));
vi.mock('../../add-ons/add-ons.service', () => ({ AddOnsService: class {} }));
vi.mock('../../audit/audit.service', () => ({ AuditService: class {} }));

import { Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from '../admin.service';
import { CONNECT_PROFILE_CHANGED } from '../../connect/profile/events/connect-profile.events';

/**
 * CN-SRCH-2 (feed harden Bucket 5) — the admin-only user-suspend/restore
 * re-index trigger (`admin.service.ts:591-614` / `:734-748`).
 *
 * QA (Stage 5): this is the "admin-only routes touched" item called out in the
 * QA mandate. `AdminController` is class-level `IsAdminGuard`-protected
 * (pre-existing, out of scope to re-verify), so the NEW behaviour to prove here
 * is that suspend/restore actually emits `CONNECT_PROFILE_CHANGED` with the
 * right userId — the freshness signal that keeps the CN-SRCH-2 query-time gate's
 * result set in step with admin actions (a suspended user drops out of people
 * search; a restored one comes back) without waiting for the next scheduled
 * reindex. No suite previously exercised this emit.
 */

const userId = new Types.ObjectId().toString();

function build(opts: { user?: any } = {}) {
  const user = 'user' in opts ? opts.user : { _id: new Types.ObjectId(userId), isActive: true };

  const userModel: any = {
    findByIdAndUpdate: vi.fn(() => ({
      select: () => ({ lean: () => Promise.resolve(user) }),
    })),
    findById: vi.fn(() => Promise.resolve(user ? { ...user, save: vi.fn() } : null)),
  };
  const workspaceModel: any = {};
  const workspaceMemberModel: any = {};
  const subscriptionModel: any = {};
  const planModel: any = {};
  const appSettingsModel: any = {};
  const tierModel: any = {};
  const ptSlabConfigModel: any = {};
  const subscriptionsService: any = {};
  const addOnsService: any = {};
  const auditService: any = {};
  const userClaimsCache: any = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const connectProfileModel: any = {};
  const eventEmitter: any = { emit: vi.fn() };

  const service = new AdminService(
    userModel,
    workspaceModel,
    workspaceMemberModel,
    subscriptionModel,
    planModel,
    appSettingsModel,
    tierModel,
    ptSlabConfigModel,
    subscriptionsService,
    addOnsService,
    auditService,
    userClaimsCache,
    connectProfileModel,
    eventEmitter,
  );

  return { service, userModel, userClaimsCache, eventEmitter };
}

describe('AdminService.updateUserStatus — CN-SRCH-2 reindex trigger', () => {
  it('emits CONNECT_PROFILE_CHANGED with the target userId when SUSPENDING a user', async () => {
    const { service, eventEmitter } = build();

    await service.updateUserStatus(userId, { isActive: false } as any);

    expect(eventEmitter.emit).toHaveBeenCalledWith(CONNECT_PROFILE_CHANGED, { userId });
  });

  it('emits CONNECT_PROFILE_CHANGED with the target userId when RE-ACTIVATING a user', async () => {
    const { service, eventEmitter } = build();

    await service.updateUserStatus(userId, { isActive: true } as any);

    expect(eventEmitter.emit).toHaveBeenCalledWith(CONNECT_PROFILE_CHANGED, { userId });
  });

  it('also drops the JWT hot-path claims cache (isActive is a cached field)', async () => {
    const { service, userClaimsCache } = build();

    await service.updateUserStatus(userId, { isActive: false } as any);

    expect(userClaimsCache.invalidate).toHaveBeenCalledWith(userId);
  });

  it('never emits (and never touches the cache) when the target user does not exist', async () => {
    const { service, eventEmitter, userClaimsCache } = build({ user: null });

    await expect(service.updateUserStatus(userId, { isActive: false } as any)).rejects.toThrow(
      NotFoundException,
    );

    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(userClaimsCache.invalidate).not.toHaveBeenCalled();
  });

  it('emits for the EXACT id passed, not a different user (no cross-account reindex leak)', async () => {
    const otherUserId = new Types.ObjectId().toString();
    const { service, eventEmitter } = build();

    await service.updateUserStatus(otherUserId, { isActive: false } as any);

    expect(eventEmitter.emit).toHaveBeenCalledWith(CONNECT_PROFILE_CHANGED, {
      userId: otherUserId,
    });
    // Never emitted for a DIFFERENT id than the one actually acted on.
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(CONNECT_PROFILE_CHANGED, { userId });
  });
});

describe('AdminService.restoreUser — CN-SRCH-2 reindex trigger', () => {
  it('emits CONNECT_PROFILE_CHANGED with the restored userId so they re-enter search', async () => {
    const { service, eventEmitter } = build();

    await service.restoreUser(userId);

    expect(eventEmitter.emit).toHaveBeenCalledWith(CONNECT_PROFILE_CHANGED, { userId });
  });

  it('also drops the JWT hot-path claims cache on restore', async () => {
    const { service, userClaimsCache } = build();

    await service.restoreUser(userId);

    expect(userClaimsCache.invalidate).toHaveBeenCalledWith(userId);
  });

  it('never emits when the user to restore does not exist', async () => {
    const { service, eventEmitter } = build({ user: null });

    await expect(service.restoreUser(userId)).rejects.toThrow(NotFoundException);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
