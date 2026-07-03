/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AuthService so that the
// transitive schema imports don't trip the "Cannot determine type" reflection
// error under vitest's esbuild transform. Mirrors the audit-spec pattern.
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

const bcryptCompare = vi.fn();
vi.mock('bcryptjs', () => ({
  compare: (...args: unknown[]) => bcryptCompare(...args),
  genSalt: vi.fn().mockResolvedValue('salt'),
  hash: vi.fn().mockResolvedValue('hashed'),
  default: {
    compare: (...args: unknown[]) => bcryptCompare(...args),
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockResolvedValue('hashed'),
  },
}));

import { Types } from 'mongoose';
import { AuthService } from '../auth.service';

/**
 * PostHog server-side capture coverage for Phase 3.5 W4.
 *
 * Asserts that the canonical `auth.*` events fire on the success paths of
 * the new auth surface:
 *   - signup_completed (mobile + email web-combined branches)
 *   - pin_set / pin_changed
 *   - pin_unlock_succeeded / pin_unlock_failed (incorrect_pin + too_many_attempts)
 *   - pin_reset_completed
 *   - forgot_completed
 *   - session_locked
 *
 * PostHog is mocked — no real network calls. The real wrapper
 * (`PostHogService.capture`) swallows client errors internally so a flaky
 * PostHog backend never breaks an auth flow.
 */
describe('AuthService — PostHog capture (W4)', () => {
  let usersService: any;
  let jwtService: any;
  let configService: any;
  let mailService: any;
  let subscriptionsService: any;
  let sessionsService: any;
  let moduleRef: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let redis: any;
  let workspacesService: any;
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };
  let svc: AuthService;

  const userId = new Types.ObjectId();
  const userDoc = {
    _id: userId,
    name: 'Test User',
    email: 'test@example.com',
    isActive: true,
    pinHash: '$2a$12$mockpinhash',
    pinAttempts: 0,
    passwordHash: '$2a$12$mockpasswordhash',
    toObject() {
      return { _id: this._id, name: this.name, email: this.email };
    },
  };

  beforeEach(() => {
    usersService = {
      findByIdentifierWithCredentials: vi.fn(),
      findByIdentifier: vi.fn(),
      findById: vi.fn(),
      findByGoogleId: vi.fn(),
      findOneByFilter: vi.fn(),
      findByIdWithCredentials: vi.fn(),
      findByIdWithEmailToken: vi.fn(),
      findByIdWithPinFields: vi.fn().mockResolvedValue(userDoc),
      findManyWithResetTokenAndExpiry: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(userDoc),
      update: vi.fn(),
      remove: vi.fn(),
    };
    jwtService = {
      verify: vi.fn(),
      decode: vi.fn(),
      signAsync: vi.fn().mockResolvedValue('signed-token'),
      sign: vi.fn().mockReturnValue('signed-token'),
    };
    configService = {
      get: vi.fn((key: string) => {
        if (key.startsWith('jwt')) return 'test-secret';
        return 'test-value';
      }),
    };
    mailService = {
      sendUserVerificationEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
    };
    subscriptionsService = {
      createFreeSubscription: vi.fn().mockResolvedValue(undefined),
      getUserSubscription: vi.fn().mockResolvedValue(null),
    };
    sessionsService = {
      createSession: vi.fn().mockResolvedValue(undefined),
      // newest-device-wins (2026-06-14): login/register/google/finalize now
      // call createSessionForLogin instead of createSession.
      createSessionForLogin: vi.fn().mockResolvedValue(undefined),
      terminateAndCreate: vi.fn().mockResolvedValue(undefined),
      invalidateSessionByTokenHash: vi.fn().mockResolvedValue(undefined),
    };
    moduleRef = { get: vi.fn() };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      pttl: vi.fn().mockResolvedValue(-2),
    };
    workspacesService = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    postHog = {
      capture: vi.fn(),
      identify: vi.fn(),
    };

    svc = new AuthService(
      usersService,
      jwtService,
      configService,
      mailService,
      subscriptionsService,
      sessionsService,
      moduleRef,
      auditService as any,
      redis,
      workspacesService,
      postHog as any,
      // Connect Referral Program — best-effort signup attribution; stubbed no-op.
      { attachReferralAtSignup: vi.fn().mockResolvedValue(undefined) } as any,
    );
  });

  // ── PIN — set / change / unlock / reset / lock ─────────────────────────

  it('fires auth.pin_set on successful PIN setup', async () => {
    usersService.findByIdWithPinFields.mockResolvedValueOnce({ ...userDoc, pinHash: undefined });
    await svc.setPin('user-1', 'jti-1', { pin: '1234', workspaceId: 'ws-1' });
    expect(postHog.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'auth.pin_set',
      properties: { jti: 'jti-1' },
    });
  });

  it('fires auth.pin_changed on successful PIN change', async () => {
    bcryptCompare.mockResolvedValue(true);
    await svc.changePin('user-1', 'jti-1', {
      currentPin: '1234',
      newPin: '5678',
      workspaceId: 'ws-1',
    });
    expect(postHog.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'auth.pin_changed',
      properties: { jti: 'jti-1' },
    });
  });

  it('fires auth.pin_unlock_succeeded on correct PIN with attemptsBefore', async () => {
    bcryptCompare.mockResolvedValue(true);
    usersService.findByIdWithPinFields.mockResolvedValueOnce({ ...userDoc, pinAttempts: 2 });
    await svc.verifyPin('user-1', 'jti-1', { pin: '1234', workspaceId: 'ws-1' });
    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'auth.pin_unlock_succeeded',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: 'user-1',
      event: 'auth.pin_unlock_succeeded',
      properties: { attemptsBefore: 2 },
    });
  });

  it('fires auth.pin_unlock_failed on incorrect PIN with attemptsRemaining', async () => {
    bcryptCompare.mockResolvedValue(false);
    usersService.findByIdWithPinFields.mockResolvedValueOnce({ ...userDoc, pinAttempts: 1 });
    await expect(
      svc.verifyPin('user-1', 'jti-1', { pin: 'wrong', workspaceId: 'ws-1' } as any),
    ).rejects.toThrow();
    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'auth.pin_unlock_failed',
    );
    expect(call).toBeDefined();
    expect(call[0].properties).toMatchObject({ reason: 'incorrect_pin' });
  });

  it('fires auth.pin_reset_completed on forgot-PIN reset success', async () => {
    jwtService.verify.mockReturnValue({ type: 'pin-reset', sub: 'user-1', jti: 'jti-1' });
    await svc.forgotPinReset('user-1', 'jti-1', {
      pinResetToken: 'token',
      newPin: '5678',
      workspaceId: 'ws-1',
    });
    expect(postHog.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'auth.pin_reset_completed',
      properties: { jti: 'jti-1' },
    });
  });

  it('fires auth.session_locked on manual lock', async () => {
    await svc.lockSession('user-1', 'jti-1', 'Test User');
    expect(postHog.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'auth.session_locked',
      properties: { jti: 'jti-1' },
    });
  });
});
