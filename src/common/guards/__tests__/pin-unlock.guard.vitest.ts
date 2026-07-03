/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Neutralise transitive schema-decoration metadata under vitest's esbuild
// transform (mirrors auth.service.pin.vitest.ts), and stub the heavy / env-
// dependent modules the guard imports so this stays a pure unit test.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});
vi.mock('../../../modules/users/users.service', () => ({ UsersService: class {} }));
vi.mock('../../../config/env', () => ({ env: { appLock: { idleMs: 300_000 } } }));
vi.mock('../../redis/redis.module', () => ({ REDIS_CLIENT: 'REDIS_CLIENT' }));

import { HttpException } from '@nestjs/common';
import { PinUnlockGuard } from '../pin-unlock.guard';
import { IS_ALLOW_WITHOUT_PIN_KEY } from '../../decorators/allow-without-pin.decorator';

/**
 * Guards the contract behind "App Lock is ERP-only": the Connect namespace
 * (`/connect/*`, `/me/connect/*`) is exempt while ERP routes stay fail-closed.
 */
describe('PinUnlockGuard — Connect is exempt (App Lock is ERP-only)', () => {
  let reflector: any;
  let usersService: any;
  let redis: any;
  let guard: PinUnlockGuard;

  const makeCtx = (req: any) =>
    ({
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => req }),
    }) as any;

  const authedUser = { sub: 'u1', jti: 'j1', family: 'f1' };

  beforeEach(() => {
    // Neither @Public nor @SkipPinUnlock by default.
    reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) };
    usersService = { findByIdWithPinFields: vi.fn().mockResolvedValue({ pinHash: 'hash' }) };
    // Locked by default (no unlock key).
    redis = { get: vi.fn().mockResolvedValue(null), expire: vi.fn().mockResolvedValue(1) };
    guard = new PinUnlockGuard(reflector, usersService, redis);
  });

  it('skips the lock for /api/connect/* even when the session is locked', async () => {
    const ctx = makeCtx({ path: '/api/connect/feed', user: authedUser });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Short-circuits before any user / Redis lookup.
    expect(usersService.findByIdWithPinFields).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('skips the lock for /api/me/connect/* (the Connect smart-entry)', async () => {
    const ctx = makeCtx({ path: '/api/me/connect/profile/entry', user: authedUser });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('skips Connect paths even without the api prefix (defensive)', async () => {
    const ctx = makeCtx({ path: '/connect/marketplace', user: authedUser });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('still LOCKS an ERP route when the unlock key is absent', async () => {
    const ctx = makeCtx({ path: '/api/workspaces/w1/salary', user: authedUser });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
    expect(usersService.findByIdWithPinFields).toHaveBeenCalledWith('u1');
  });

  it('allows an ERP route when unlocked, and slides the TTL', async () => {
    const ctx = makeCtx({ path: '/api/workspaces/w1/salary', user: authedUser });
    redis.get.mockResolvedValue('300');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(redis.expire).toHaveBeenCalledWith('unlocked:fam:f1', 300);
  });

  it('does not treat a lookalike path (/api/connection-tests) as Connect', async () => {
    const ctx = makeCtx({ path: '/api/connection-tests', user: authedUser });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  it('skips the lock for a connect-* category upload on the shared /uploads endpoint', async () => {
    const ctx = makeCtx({
      path: '/api/uploads/single',
      query: { category: 'connect-inbox-media' },
      user: authedUser,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Short-circuits before any user / Redis lookup, like the path-based exemptions.
    expect(usersService.findByIdWithPinFields).not.toHaveBeenCalled();
  });

  it('reads the connect category from the raw URL query when req.query is absent', async () => {
    const ctx = makeCtx({
      path: '/api/uploads/single',
      originalUrl: '/api/uploads/single?category=connect-post-media',
      user: authedUser,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('still LOCKS an ERP-category upload (category not connect-*)', async () => {
    const ctx = makeCtx({
      path: '/api/uploads/single',
      query: { category: 'team-document' },
      user: authedUser,
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  // Account self-service surface (subscription / billing / add-ons) is exempt
  // too - it backs the shared /account/* area and holds only the user's OWN
  // plan/billing data, never workspace payroll. ADMIN billing stays locked.
  it.each([
    '/api/subscriptions/my',
    '/api/subscriptions/payments',
    '/api/subscriptions/checkout',
    '/api/subscriptions/dunning/status',
    '/api/add-ons',
    '/api/add-ons/credit-pack/history',
    '/api/users/me/billing',
  ])('skips the lock for account self-service path %s', async (path) => {
    const ctx = makeCtx({ path, user: authedUser });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(usersService.findByIdWithPinFields).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it.each([
    '/api/admin/billing/payments',
    '/api/admin/subscriptions/assign',
    '/api/admin/billing/plans',
  ])('still LOCKS admin billing path %s (not account self-service)', async (path) => {
    const ctx = makeCtx({ path, user: authedUser });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  it('does not treat a lookalike path (/api/subscriptions-archive) as self-service', async () => {
    const ctx = makeCtx({ path: '/api/subscriptions-archive', user: authedUser });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });
});

/**
 * App-Lock onboarding contract (2026-06-20): a user with NO PIN yet must be able
 * to reach @AllowWithoutPin routes — the canonical one is POST /workspaces
 * (create the FIRST workspace, which precedes PIN setup). The marker is honoured
 * ONLY in the no-PIN branch: a PIN-holder who is locked stays blocked, so this
 * does not weaken App Lock for established ERP users (unlike @SkipPinUnlock,
 * which exempts everyone). Guards the Connect-only -> ERP onboarding path (no
 * PIN + expired setup-grace) that otherwise 423'd workspace creation.
 */
describe('PinUnlockGuard — @AllowWithoutPin (pre-PIN onboarding)', () => {
  let reflector: any;
  let usersService: any;
  let redis: any;
  let guard: PinUnlockGuard;

  const makeCtx = (req: any) =>
    ({
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => req }),
    }) as any;

  const authedUser = { sub: 'u1', jti: 'j1', family: 'f1' };

  beforeEach(() => {
    // @AllowWithoutPin present by default; not @Public / @SkipPinUnlock.
    reflector = {
      getAllAndOverride: vi.fn((key: string) => key === IS_ALLOW_WITHOUT_PIN_KEY),
    };
    // Locked by default (no unlock / grace key).
    redis = { get: vi.fn().mockResolvedValue(null), expire: vi.fn().mockResolvedValue(1) };
    usersService = { findByIdWithPinFields: vi.fn() };
    guard = new PinUnlockGuard(reflector, usersService, redis);
  });

  it('lets a NO-PIN user through (first-workspace onboarding, no grace needed)', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue({}); // no pinHash
    const ctx = makeCtx({ path: '/api/workspaces', user: authedUser });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('still LOCKS a PIN-HOLDER who is locked, even on an @AllowWithoutPin route', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue({ pinHash: 'hash' });
    redis.get.mockResolvedValue(null); // no unlock key -> locked
    const ctx = makeCtx({ path: '/api/workspaces', user: authedUser });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  it('a NO-PIN user on a NON-marked route still gets 423 pin_setup_required', async () => {
    reflector.getAllAndOverride.mockReturnValue(false); // no markers at all
    usersService.findByIdWithPinFields.mockResolvedValue({}); // no pinHash
    const ctx = makeCtx({ path: '/api/workspaces/w1/salary', user: authedUser });
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({ reason: 'pin_setup_required' });
  });
});
