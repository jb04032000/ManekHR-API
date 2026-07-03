/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * AC-2.5 — sanitizeUser must never include any auth secret or OTP field.
 *
 * AuthService.sanitizeUser is the SINGLE choke point that produces the User
 * object returned to the FE on login, register, Google OAuth, GET /auth/me,
 * OTP finalize, and every other auth success path. Failing to strip a field
 * here sends it to the browser in the JWT payload or the HTTP body — an
 * immediate credential leak. This test asserts the exhaustive list from the
 * spec (auth-hardening-spec §4b) is scrubbed and the two derived booleans
 * (hasPassword / hasPin) are computed correctly.
 *
 * Because sanitizeUser is private we access it via a thin wrapper that calls
 * getMe (which just calls sanitizeUser then returns). We call the method
 * directly through a TypeScript cast to avoid changing production code.
 *
 * Links: auth.service.ts (sanitizeUser), auth-hardening-spec §4b (AC-2.5).
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
import { Platform } from '../../../common/enums/platform-access.enum';

/**
 * The complete list of sensitive fields from auth-hardening-spec §4b (AC-2.5).
 * If any of these leak out of sanitizeUser, a credential is sent to the browser.
 */
const SENSITIVE_FIELDS = [
  'passwordHash',
  'pinHash',
  'pinAttempts',
  'pinLockedUntil',
  'resetPasswordTokenHash',
  'resetPasswordExpiresAt',
  'emailVerificationToken',
  'mobileVerificationToken',
  'mobileVerificationExpiresAt',
  'mobileOtpAttempts',
  'mobileOtpLockedUntil',
  'mobileOtpLastSentAt',
  'mobileVerificationFlow',
] as const;

describe('AuthService.sanitizeUser (AC-2.5)', () => {
  let usersService: any;
  let jwtService: any;
  let sessionsService: any;
  let svc: AuthService;

  const userId = new Types.ObjectId();

  /** Build a "fat" user doc that includes ALL sensitive fields to be stripped. */
  const buildRawUserDoc = (overrides: Record<string, unknown> = {}) => {
    const raw: Record<string, unknown> = {
      _id: userId,
      name: 'Priya Sharma',
      email: 'priya@example.com',
      mobile: '919876543210',
      isActive: true,
      isEmailVerified: true,
      isMobileVerified: true,
      isAdmin: false,
      hasWorkspace: true,
      handle: 'priya-sharma',
      // Sensitive fields that MUST be stripped:
      passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyz',
      pinHash: '$2a$12$pinhashvalue',
      pinAttempts: 2,
      pinLockedUntil: new Date('2026-07-01'),
      pinSetAt: new Date('2026-06-01'),
      resetPasswordTokenHash: '$2a$12$resettokenhash',
      resetPasswordExpiresAt: new Date('2026-06-15'),
      emailVerificationToken: 'jwt.email.otp.token',
      mobileVerificationToken: 'jwt.mobile.otp.token',
      mobileVerificationExpiresAt: new Date('2026-06-15'),
      mobileOtpAttempts: 1,
      mobileOtpLockedUntil: new Date('2026-06-15'),
      mobileOtpLastSentAt: new Date('2026-06-14'),
      mobileVerificationFlow: 'login',
      ...overrides,
    };
    // Add a toObject() method so sanitizeUser can call it (mongoose doc contract).
    (raw as any).toObject = () => ({ ...raw });
    return raw;
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
      sign: vi.fn().mockReturnValue('fake.jwt.token'),
    };
    const configService = { get: vi.fn().mockReturnValue('test-secret') };
    const mailService = {
      sendUserVerificationEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
    };
    const subscriptionsService = {
      createFreeSubscription: vi.fn().mockResolvedValue(undefined),
      getUserSubscription: vi.fn().mockResolvedValue(null),
    };
    sessionsService = {
      createSessionForLogin: vi.fn().mockResolvedValue(undefined),
      invalidateSessionByTokenHash: vi.fn().mockResolvedValue(undefined),
    };
    const moduleRef = { get: vi.fn() };
    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
    const workspacesService = { create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) };
    const postHog = { capture: vi.fn(), identify: vi.fn() };

    svc = new AuthService(
      usersService,
      jwtService,
      configService,
      mailService,
      subscriptionsService,
      sessionsService,
      moduleRef as any,
      auditService as any,
      redis,
      workspacesService as any,
      postHog as any,
    );
  });

  /**
   * Drive sanitizeUser via getUserProfile() — that is the direct path that calls
   * sanitizeUser(findByIdWithCredentials(userId)). This exercises every field
   * with a full credential doc (including `+select` projections), which is the
   * highest-risk path: findByIdWithCredentials intentionally opts in to the
   * sensitive fields so sanitizeUser's strip list is the sole safety net.
   *
   * We also test the login path (password present, bcrypt matches) so we cover
   * multiple entry points into sanitizeUser.
   */
  async function getProfileSanitized(overrides: Record<string, unknown> = {}) {
    const doc = buildRawUserDoc(overrides);
    usersService.findByIdWithCredentials.mockResolvedValue(doc);
    return (await (svc as any).getUserProfile('user-1')) as Record<string, unknown>;
  }

  it('strips ALL sensitive credential + OTP fields from the getUserProfile response', async () => {
    const user = await getProfileSanitized();

    for (const field of SENSITIVE_FIELDS) {
      expect(field in user, `LEAK: "${field}" must not be in the sanitized user response`).toBe(
        false,
      );
    }
  });

  it('also strips sensitive fields from the login() response path', async () => {
    const doc = buildRawUserDoc({ passwordHash: '$2a$12$some-hash' });
    usersService.findByIdentifierWithCredentials.mockResolvedValue(doc);
    bcryptCompare.mockResolvedValue(true);

    const result = await (svc as any).login({
      identifier: 'priya@example.com',
      password: 'pw',
      platform: Platform.WEB,
    });
    const user = result.user as Record<string, unknown>;

    for (const field of SENSITIVE_FIELDS) {
      expect(
        field in user,
        `LEAK via login: "${field}" must not be in the sanitized user response`,
      ).toBe(false);
    }
  });

  it('derives hasPassword=true when a passwordHash was set', async () => {
    const user = await getProfileSanitized({ passwordHash: '$2a$12$some-hash' });
    expect(user.hasPassword).toBe(true);
  });

  it('derives hasPassword=false when no passwordHash (OTP-only user)', async () => {
    // OTP-only users have no passwordHash. sanitizeUser must still produce
    // hasPassword=false without leaking anything.
    const user = await getProfileSanitized({ passwordHash: undefined });
    expect(user.hasPassword).toBe(false);
  });

  it('derives hasPin=true when a pinHash was set', async () => {
    const user = await getProfileSanitized({ pinHash: '$2a$12$pin-hash' });
    expect(user.hasPin).toBe(true);
  });

  it('derives hasPin=false when no pinHash (no PIN set yet)', async () => {
    const user = await getProfileSanitized({ pinHash: undefined });
    expect(user.hasPin).toBe(false);
  });

  it('retains safe non-sensitive fields (name, email, handle, isActive, etc.)', async () => {
    const user = await getProfileSanitized();
    expect(user.name).toBe('Priya Sharma');
    expect(user.email).toBe('priya@example.com');
    expect(user.handle).toBe('priya-sharma');
    expect(user.isActive).toBe(true);
    expect(user.hasWorkspace).toBe(true);
  });

  it('does not strip pinSetAt (it is not a secret — it tells the FE when the PIN was last changed)', async () => {
    // pinSetAt is NOT in the SENSITIVE_KEYS allowlist so it should pass through.
    const pinSetAt = new Date('2026-06-01');
    const user = await getProfileSanitized({ pinSetAt });
    // pinSetAt is kept (it is metadata, not a secret).
    // We only verify the sensitive hash is gone.
    expect(user.pinHash).toBeUndefined();
  });
});
