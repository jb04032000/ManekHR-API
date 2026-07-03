/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AuthService so that the
// transitive schema imports (Session, WorkspaceMember, etc.) don't trip the
// "Cannot determine type" reflection error under vitest's esbuild transform.
// We never actually use Mongoose here — all Models are injected as plain mocks.
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

// Mock bcryptjs so we can flip success/failure per test without spy redefinition.
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
import { AppModule } from '../../../common/enums/modules.enum';
import { Platform } from '../../../common/enums/platform-access.enum';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';

/**
 * Audit fire-and-forget coverage for the 6 W4 auth events:
 *   register_success, login_success, login_failure,
 *   oauth_google_success, password_reset_success, logout_success
 *
 * Verifies:
 *   - Each event fires with workspaceId: null + module: AppModule.AUTH +
 *     entityType: 'auth_event' + the expected action string.
 *   - login_failure is suppressed when the identifier resolves to no user
 *     (avoids audit noise for typo'd / probing identifiers per W4 spec).
 *   - Audit failures are swallowed and never break the auth flow.
 */
describe('AuthService — audit fire-and-forget (W4)', () => {
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
  const userDoc = {
    _id: userId,
    name: 'Test User',
    email: 'test@example.com',
    isActive: true,
    passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyz',
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        email: this.email,
        isActive: this.isActive,
      };
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
      findByIdWithPinFields: vi.fn().mockResolvedValue(null),
      findManyWithResetTokenAndExpiry: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    jwtService = {
      verify: vi.fn(),
      decode: vi.fn(),
      signAsync: vi.fn(),
      sign: vi.fn(),
    };
    configService = { get: vi.fn().mockReturnValue('test-secret') };
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

    // Stub out the issueTokens utility's downstream side-effects by giving the
    // jwtService.sign a deterministic return.
    jwtService.sign.mockReturnValue('fake.jwt.token');
  });

  // Force a tick so fire-and-forget microtasks settle.
  const settle = () => new Promise((r) => setImmediate(r));

  it('fires login_success on successful credential login', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue(userDoc);
    bcryptCompare.mockResolvedValue(true);

    await svc.login({
      identifier: 'test@example.com',
      password: 'pw',
      platform: Platform.WEB,
    });

    await settle();
    expect(auditService.logEvent).toHaveBeenCalled();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'login_success',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      workspaceId: null,
      module: AppModule.AUTH,
      entityType: 'auth_event',
      action: 'login_success',
    });
    expect(call[0].entityId.toString()).toBe(userId.toString());
    expect(call[0].actorId.toString()).toBe(userId.toString());
  });

  it('fires login_failure with reason "invalid_password" when password mismatches', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue(userDoc);
    bcryptCompare.mockResolvedValue(false);

    await expect(
      svc.login({
        identifier: 'test@example.com',
        password: 'wrong',
        platform: Platform.WEB,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'login_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ reason: 'invalid_password' });
  });

  it('fires login_failure with reason "account_deactivated" when user is inactive', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue({
      ...userDoc,
      isActive: false,
      deactivationNote: 'admin removed',
    });

    await expect(
      svc.login({
        identifier: 'test@example.com',
        password: 'pw',
        platform: Platform.WEB,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'login_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ reason: 'account_deactivated' });
  });

  it('login on a pending-deletion account returns the scheduled-for-deletion error + audits reason "scheduled_for_deletion"', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue({
      ...userDoc,
      isActive: false,
      accountDeletion: {
        state: 'pending',
        purgeAfter: new Date('2026-07-25T00:00:00.000Z'),
      },
    });

    await expect(
      svc.login({
        identifier: 'test@example.com',
        password: 'pw',
        platform: Platform.WEB,
      } as any),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SCHEDULED_FOR_DELETION' },
    });

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'login_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ reason: 'scheduled_for_deletion' });
  });

  it('does NOT fire any audit event when login identifier matches no user', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue(null);

    await expect(
      svc.login({
        identifier: 'ghost@example.com',
        password: 'pw',
        platform: Platform.WEB,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await settle();
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('fires logout_success when revokeTokens is called with an actorUserId', async () => {
    jwtService.decode.mockReturnValue({
      jti: 'fake-jti',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await svc.revokeTokens('refresh-token', 'access-token', userId.toString());

    await settle();
    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    expect(auditService.logEvent.mock.calls[0][0]).toMatchObject({
      workspaceId: null,
      module: AppModule.AUTH,
      action: 'logout_success',
    });
  });

  it('skips logout audit when actorUserId is omitted (legacy callers)', async () => {
    jwtService.decode.mockReturnValue({
      jti: 'fake-jti',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await svc.revokeTokens('refresh-token', 'access-token');

    await settle();
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('fires password_reset_success on successful password reset', async () => {
    // New contract: forgotPassword mints a raw token, bcrypt-hashes it,
    // persists `resetPasswordTokenHash`. resetPassword loads candidates via
    // findManyWithResetTokenAndExpiry and bcrypt-compares incoming token
    // against each stored hash.
    const rawToken = 'a'.repeat(64);
    usersService.findManyWithResetTokenAndExpiry.mockResolvedValue([
      {
        ...userDoc,
        resetPasswordTokenHash: '$2a$12$mockhashforresettoken',
        resetPasswordExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    ]);
    bcryptCompare.mockResolvedValue(true);
    usersService.update.mockResolvedValue(userDoc);

    await svc.resetPassword({ token: rawToken, newPassword: 'newpw123' });

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'password_reset_success',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      workspaceId: null,
      module: AppModule.AUTH,
      entityType: 'auth_event',
      action: 'password_reset_success',
    });
  });

  // ── forgotPassword (explicit-feedback policy 2026-05-09) ──────────────
  // Anti-enumeration was dropped in favour of explicit "not registered"
  // feedback for the SMB owner audience. Rate limiter (5/min on the
  // endpoint) is the real protection now.

  it('forgotPassword throws IDENTIFIER_NOT_REGISTERED + audits unknown attempt when no user matches', async () => {
    usersService.findByIdentifier.mockResolvedValue(null);

    await expect(
      svc.forgotPassword({ identifier: 'ghost@example.com' } as any),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTIFIER_NOT_REGISTERED',
      },
    });

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'password_reset_unknown_identifier',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      workspaceId: null,
      module: AppModule.AUTH,
      entityType: 'auth_event',
      action: 'password_reset_unknown_identifier',
    });
    expect(call[0].meta).toMatchObject({ channel: 'email', identifierShape: 'email' });
  });

  it('forgotPassword sends + audits password_reset_link_sent when user exists with email', async () => {
    usersService.findByIdentifier.mockResolvedValue(userDoc);
    usersService.update.mockResolvedValue(userDoc);

    await expect(
      svc.forgotPassword({ identifier: 'test@example.com' } as any),
    ).resolves.toMatchObject({
      message: expect.stringContaining('password reset link'),
    });

    await settle();
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'password_reset_link_sent',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ channel: 'email' });
  });

  it('forgotPassword throws EMAIL_NOT_ON_FILE when user exists but has no email', async () => {
    usersService.findByIdentifier.mockResolvedValue({ ...userDoc, email: undefined });

    await expect(svc.forgotPassword({ identifier: '9876543210' } as any)).rejects.toMatchObject({
      response: {
        code: 'EMAIL_NOT_ON_FILE',
      },
    });

    expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('does not throw when audit logEvent rejects (fire-and-forget)', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue(userDoc);
    bcryptCompare.mockResolvedValue(true);
    auditService.logEvent.mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      svc.login({
        identifier: 'test@example.com',
        password: 'pw',
        platform: Platform.WEB,
      } as any),
    ).resolves.toBeDefined();

    await settle();
    expect(auditService.logEvent).toHaveBeenCalled();
  });
});
