/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror auth.service.audit.vitest.ts harness — neutralise transitive
// schema-decoration metadata under vitest's esbuild transform.
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
  hash: vi.fn().mockResolvedValue('new-pin-hash'),
  default: {
    compare: (...args: unknown[]) => bcryptCompare(...args),
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockResolvedValue('new-pin-hash'),
  },
}));

import { Types } from 'mongoose';
import { AuthService } from '../auth.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';

describe('AuthService — App Lock (Quick PIN)', () => {
  let usersService: any;
  let jwtService: any;
  let configService: any;
  let mailService: any;
  let subscriptionsService: any;
  let sessionsService: any;
  let moduleRef: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let redis: any;
  let svc: AuthService;

  const userId = new Types.ObjectId();
  const jti = 'fake-jti-aaa';

  const baseUserDoc = (overrides: Record<string, unknown> = {}) => ({
    _id: userId,
    name: 'Test User',
    email: 'test@example.com',
    isActive: true,
    pinHash: undefined,
    pinAttempts: 0,
    pinLockedUntil: null,
    pinSetAt: null,
    passwordHash: '$2a$12$pwhash',
    googleId: undefined,
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        email: this.email,
        isActive: this.isActive,
      };
    },
    ...overrides,
  });

  beforeEach(() => {
    bcryptCompare.mockReset();
    usersService = {
      findById: vi.fn(),
      findByIdWithCredentials: vi.fn(),
      findByIdWithEmailToken: vi.fn(),
      findByIdWithPinFields: vi.fn(),
      findByIdentifier: vi.fn(),
      findByIdentifierWithCredentials: vi.fn(),
      findByGoogleId: vi.fn(),
      findOneByFilter: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // resolveAppLockTtlSec now reads the per-user idle override first
      // (user -> workspace -> env). Default null = no override, so resolution
      // falls through to the env default exactly as before this change.
      getAppLockIdleMs: vi.fn().mockResolvedValue(null),
    };
    jwtService = {
      verify: vi.fn(),
      decode: vi.fn(),
      signAsync: vi.fn().mockResolvedValue('signed-pin-reset-token'),
      sign: vi.fn(),
    };
    configService = { get: vi.fn().mockReturnValue('test-secret') };
    mailService = { sendUserVerificationEmail: vi.fn() };
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

    const workspacesService = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    const postHog = { capture: vi.fn(), identify: vi.fn() };
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
      workspacesService as any,
      postHog as any,
    );
  });

  // Force fire-and-forget audit microtasks to settle.
  const settle = () => new Promise((r) => setImmediate(r));

  // ─────────────── setPin ───────────────

  it('setPin: success — writes pin, fires pin_set_success, sets unlock + clears grace', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(baseUserDoc());
    usersService.update.mockResolvedValue(baseUserDoc());

    const res = await svc.setPin(userId.toString(), jti, { pin: '123456' });

    expect(res.ok).toBe(true);
    expect(typeof res.unlockExpiresAt).toBe('string');
    expect(usersService.update).toHaveBeenCalledWith(
      userId.toString(),
      expect.objectContaining({
        pinHash: 'new-pin-hash',
        pinAttempts: 0,
      }),
    );
    expect(redis.del).toHaveBeenCalledWith(`setup-grace:jti:${jti}`);
    expect(redis.set).toHaveBeenCalledWith(
      `unlocked:jti:${jti}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'pin_set_success',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      workspaceId: null,
      module: AppModule.AUTH,
      entityType: 'auth_event',
      action: 'pin_set_success',
    });
    expect(call[0].meta).toMatchObject({ jti });
  });

  it('setPin: rejects with PIN_ALREADY_SET when pinHash already populated', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );

    await expect(svc.setPin(userId.toString(), jti, { pin: '123456' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await settle();
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  // ─────────────── changePin ───────────────

  it('changePin: rejects when currentPin mismatches + fires pin_change_failure', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    bcryptCompare.mockResolvedValue(false);

    await expect(
      svc.changePin(userId.toString(), jti, {
        currentPin: '000000',
        newPin: '111111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'pin_change_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ reason: 'incorrect_current_pin' });
  });

  it('changePin: success — updates hash + refreshes unlock + fires pin_change_success', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(true);

    const res = await svc.changePin(userId.toString(), jti, {
      currentPin: '000000',
      newPin: '111111',
    });

    expect(res.ok).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      `unlocked:jti:${jti}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    await settle();
    expect(
      auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === 'pin_change_success'),
    ).toBeDefined();
  });

  // ─────────────── verifyPin ───────────────

  it('verifyPin: success — resets counter, writes unlock, fires pin_unlock_success', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing', pinAttempts: 2 }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(true);

    const res = await svc.verifyPin(userId.toString(), jti, { pin: '123456' });
    expect(res.ok).toBe(true);

    expect(usersService.update).toHaveBeenCalledWith(
      userId.toString(),
      expect.objectContaining({ pinAttempts: 0 }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      `unlocked:jti:${jti}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    await settle();
    expect(
      auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === 'pin_unlock_success'),
    ).toBeDefined();
  });

  it('verifyPin: wrong PIN — increments counter, fires pin_unlock_failure(incorrect_pin), throws 423 PIN_INCORRECT', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing', pinAttempts: 1 }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(false);

    await expect(svc.verifyPin(userId.toString(), jti, { pin: '000000' })).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(usersService.update).toHaveBeenCalledWith(
      userId.toString(),
      expect.objectContaining({ pinAttempts: 2 }),
    );

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'pin_unlock_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({
      reason: 'incorrect_pin',
      attempts: 2,
    });
  });

  it('verifyPin: 5th wrong attempt — locks out with PIN_LOCKOUT_FORGOT_REQUIRED', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing', pinAttempts: 4 }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(false);

    let thrown: any;
    try {
      await svc.verifyPin(userId.toString(), jti, { pin: '000000' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown.getResponse()).toMatchObject({
      code: 'PIN_LOCKOUT_FORGOT_REQUIRED',
      attemptsRemaining: 0,
    });
  });

  it('verifyPin: when pinAttempts already at max, refuses without comparing PIN', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing', pinAttempts: 5 }),
    );

    let thrown: any;
    try {
      await svc.verifyPin(userId.toString(), jti, { pin: '999999' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  // ─────────────── getPinStatus ───────────────

  it('getPinStatus: pinSet=false when no PIN', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(baseUserDoc());

    const res = await svc.getPinStatus(userId.toString(), jti);
    expect(res).toEqual({
      pinSet: false,
      locked: false,
      unlockExpiresAt: null,
    });
  });

  it('getPinStatus: pinSet=true + locked=true when pttl is -2 (no unlock key)', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    redis.pttl.mockResolvedValue(-2);

    const res = await svc.getPinStatus(userId.toString(), jti);
    expect(res.pinSet).toBe(true);
    expect(res.locked).toBe(true);
    expect(res.unlockExpiresAt).toBeNull();
  });

  it('getPinStatus: pinSet=true + locked=false when pttl > 0', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    redis.pttl.mockResolvedValue(120000);

    const res = await svc.getPinStatus(userId.toString(), jti);
    expect(res.pinSet).toBe(true);
    expect(res.locked).toBe(false);
    expect(typeof res.unlockExpiresAt).toBe('string');
  });

  it('getPinStatus: Redis pttl throws — fail-CLOSED, returns locked', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    redis.pttl.mockRejectedValue(new Error('redis down'));

    const res = await svc.getPinStatus(userId.toString(), jti);
    expect(res.locked).toBe(true);
  });

  // ─────────────── forgotPinCredentialVerify ───────────────

  it('forgotPinCredentialVerify(password): success — returns pinResetToken + fires audit', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    bcryptCompare.mockResolvedValue(true);

    const res = await svc.forgotPinCredentialVerify(userId.toString(), jti, {
      kind: 'password',
      password: 'pw',
    });

    expect(res.pinResetToken).toBe('signed-pin-reset-token');
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: userId.toString(),
        jti,
        type: 'pin-reset',
      }),
      expect.any(Object),
    );

    await settle();
    expect(
      auditService.logEvent.mock.calls.find(
        (c: any[]) => c[0].action === 'pin_reset_credential_verified',
      ),
    ).toBeDefined();
  });

  it('forgotPinCredentialVerify(password): rejects when password mismatches + fires failure audit', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(false);

    await expect(
      svc.forgotPinCredentialVerify(userId.toString(), jti, {
        kind: 'password',
        password: 'wrong',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await settle();
    expect(
      auditService.logEvent.mock.calls.find(
        (c: any[]) => c[0].action === 'pin_reset_credential_failure',
      ),
    ).toBeDefined();
  });

  // ─────────────── forgotPinReset ───────────────

  it('forgotPinReset: rejects when pinResetToken type wrong', async () => {
    jwtService.verify.mockReturnValue({
      sub: userId.toString(),
      jti,
      type: 'email-verify',
    });
    usersService.findByIdWithPinFields.mockResolvedValue(baseUserDoc({ pinHash: '$2a$12$old' }));

    await expect(
      svc.forgotPinReset(userId.toString(), jti, {
        pinResetToken: 'tok',
        newPin: '222222',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forgotPinReset: rejects when token jti does not match current session jti', async () => {
    jwtService.verify.mockReturnValue({
      sub: userId.toString(),
      jti: 'different-jti',
      type: 'pin-reset',
    });

    await expect(
      svc.forgotPinReset(userId.toString(), jti, {
        pinResetToken: 'tok',
        newPin: '222222',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forgotPinReset: success — clears counter + writes unlock + fires pin_reset_success', async () => {
    jwtService.verify.mockReturnValue({
      sub: userId.toString(),
      jti,
      type: 'pin-reset',
    });
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$old', pinAttempts: 5 }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());

    const res = await svc.forgotPinReset(userId.toString(), jti, {
      pinResetToken: 'tok',
      newPin: '222222',
    });

    expect(res.ok).toBe(true);
    expect(usersService.update).toHaveBeenCalledWith(
      userId.toString(),
      expect.objectContaining({ pinAttempts: 0, pinHash: 'new-pin-hash' }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      `unlocked:jti:${jti}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    await settle();
    expect(
      auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === 'pin_reset_success'),
    ).toBeDefined();
  });

  // ─────────────── family-keyed unlock (PIN-loop fix) ───────────────

  it('verifyPin: keys the unlock on family when a family is supplied', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing', pinAttempts: 0 }),
    );
    usersService.update.mockResolvedValue(baseUserDoc());
    bcryptCompare.mockResolvedValue(true);

    await svc.verifyPin(userId.toString(), jti, { pin: '123456' }, 'fam-xyz');

    expect(redis.set).toHaveBeenCalledWith(
      'unlocked:fam:fam-xyz',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('setPin: keys unlock + grace on family when a family is supplied', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(baseUserDoc());
    usersService.update.mockResolvedValue(baseUserDoc());

    await svc.setPin(userId.toString(), jti, { pin: '123456' }, 'fam-xyz');

    expect(redis.del).toHaveBeenCalledWith('setup-grace:fam:fam-xyz');
    expect(redis.set).toHaveBeenCalledWith(
      'unlocked:fam:fam-xyz',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('getPinStatus: reads the family-keyed unlock when a family is supplied', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(
      baseUserDoc({ pinHash: '$2a$12$existing' }),
    );
    redis.pttl.mockResolvedValue(120000);

    const res = await svc.getPinStatus(userId.toString(), jti, 'fam-xyz');

    expect(redis.pttl).toHaveBeenCalledWith('unlocked:fam:fam-xyz');
    expect(res.locked).toBe(false);
  });

  it('lockSession: deletes the family-keyed unlock when a family is supplied', async () => {
    await svc.lockSession(userId.toString(), jti, undefined, 'fam-xyz');
    expect(redis.del).toHaveBeenCalledWith('unlocked:fam:fam-xyz');
  });

  // ─────────────── lockSession ───────────────

  it('lockSession: deletes unlock key + fires pin_manual_lock', async () => {
    const res = await svc.lockSession(userId.toString(), jti, 'Test User');
    expect(res.ok).toBe(true);
    expect(redis.del).toHaveBeenCalledWith(`unlocked:jti:${jti}`);

    await settle();
    expect(
      auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === 'pin_manual_lock'),
    ).toBeDefined();
  });

  // ─────────────── audit failure swallow ───────────────

  it('does not throw when audit logEvent rejects (fire-and-forget)', async () => {
    usersService.findByIdWithPinFields.mockResolvedValue(baseUserDoc());
    usersService.update.mockResolvedValue(baseUserDoc());
    auditService.logEvent.mockRejectedValueOnce(new Error('audit boom'));

    await expect(svc.setPin(userId.toString(), jti, { pin: '123456' })).resolves.toBeDefined();
  });
});
