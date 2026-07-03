/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing MobileOtpService so that
// the transitive schema imports don't trip vitest's esbuild reflect-metadata.
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

// Override @nestjs/common exception constructors. vi.mock is hoisted, so the
// factory must be self-contained (no references to outer-scope variables). We
// define the Exception subclasses inline inside the factory to avoid the
// "Cannot access before initialization" TDZ error.
vi.mock('@nestjs/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/common')>();
  // Structured-payload aware mock: accepts either a bare string (legacy) or
  // a `{ code, message, ...extras }` object payload (current contract). The
  // payload is stored on `.response` so tests can assert on the BE error
  // envelope shape (code / attempts / etc.) the FE branches on.
  class BaseException extends Error {
    response: unknown;
    constructor(payload: unknown) {
      const msg =
        typeof payload === 'string' ? payload : ((payload as { message?: string })?.message ?? '');
      super(msg);
      this.response = payload;
    }
    getResponse() {
      return this.response;
    }
  }
  class BadRequestException extends BaseException {
    constructor(payload: unknown) {
      super(payload);
      this.name = 'BadRequestException';
    }
  }
  class UnauthorizedException extends BaseException {
    constructor(payload: unknown) {
      super(payload);
      this.name = 'UnauthorizedException';
    }
  }
  class TooManyRequestsException extends BaseException {
    constructor(payload: unknown) {
      super(payload);
      this.name = 'TooManyRequestsException';
    }
  }
  class Logger {
    log = () => undefined;
    error = () => undefined;
    warn = () => undefined;
    debug = () => undefined;
  }
  return {
    ...actual,
    BadRequestException,
    UnauthorizedException,
    TooManyRequestsException,
    Injectable: () => () => undefined,
    Logger,
  };
});

// Mock bcryptjs - control compare/hash per test without spy redefinition.
const bcryptHash = vi.fn();
const bcryptCompare = vi.fn();
vi.mock('bcryptjs', () => ({
  hash: (...args: unknown[]) => bcryptHash(...args),
  compare: (...args: unknown[]) => bcryptCompare(...args),
  default: {
    hash: (...args: unknown[]) => bcryptHash(...args),
    compare: (...args: unknown[]) => bcryptCompare(...args),
  },
}));

// Mock crypto so randomInt is deterministic in tests.
vi.mock('crypto', () => ({
  randomInt: vi.fn().mockReturnValue(123456),
  default: { randomInt: vi.fn().mockReturnValue(123456) },
}));

import { Types } from 'mongoose';
import { MobileOtpService } from '../mobile-otp.service';

// Import the mocked exception classes so our tests can use instanceof.
import { TooManyRequestsException } from '@nestjs/common';

/** Helper: build a minimal OTP doc mock. */
function makeOtpDoc(
  overrides: Partial<{
    attempts: number;
    consumedAt: Date | null;
    codeHash: string;
    save: () => Promise<unknown>;
  }> = {},
) {
  return {
    attempts: 0,
    consumedAt: null,
    codeHash: 'hashed-code',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('MobileOtpService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const mobile = '919876543210';
  const requestedBy = new Types.ObjectId().toHexString();

  let otpModel: any;
  let smsService: any;
  let auditService: any;
  let jwtService: any;
  let postHogService: any;
  let svc: MobileOtpService;

  beforeEach(() => {
    bcryptHash.mockReset();
    bcryptCompare.mockReset();
    bcryptHash.mockResolvedValue('hashed-code');
    bcryptCompare.mockResolvedValue(true);

    otpModel = {
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      create: vi.fn().mockResolvedValue({}),
      findOne: vi.fn(),
    };
    smsService = {
      sendDltSms: vi.fn().mockResolvedValue({ status: 'sent' }),
    };
    auditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };
    jwtService = {
      signAsync: vi.fn().mockResolvedValue('signed.jwt.token'),
      verifyAsync: vi.fn(),
    };
    // Phase 1f.3 — PostHog server-side capture wired into MobileOtpService.
    // Mock satisfies the `capture(...)` + `identify(...)` surface so the
    // service can emit telemetry without a real PostHog client.
    postHogService = {
      capture: vi.fn(),
      identify: vi.fn(),
    };

    svc = new MobileOtpService(otpModel, smsService, auditService, jwtService, postHogService);
  });

  // Force fire-and-forget microtasks to settle.
  const settle = () => new Promise((r) => setImmediate(r));

  // -- Test 1: startVerification generates code + sends SMS -----------------

  it('startVerification generates OTP and sends SMS', async () => {
    const result = await svc.startVerification(workspaceId, mobile, requestedBy);

    expect(otpModel.create).toHaveBeenCalledOnce();
    const createArg = otpModel.create.mock.calls[0][0];
    // Plaintext code is NEVER persisted - only the hash.
    expect(createArg.codeHash).toBe('hashed-code');
    expect(createArg.mobile).toBe(mobile);
    expect(createArg.consumedAt).toBeNull();

    expect(smsService.sendDltSms).toHaveBeenCalledOnce();
    const smsArg = smsService.sendDltSms.mock.calls[0][0];
    expect(smsArg.mobile).toBe(mobile);
    expect(smsArg.templateId).toBe('TEAM_MOBILE_OTP_PLACEHOLDER');

    expect(result.sent).toBe(true);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Phase 1f.3 — PostHog capture mirrors the audit event. Properties
    // carry workspaceId + mobileLast4 only (never the full PII number).
    expect(postHogService.capture).toHaveBeenCalledWith({
      distinctId: requestedBy,
      event: 'team.mobile_otp_sent',
      properties: { workspaceId, mobileLast4: mobile.slice(-4) },
    });
  });

  // -- Test 2: per-number 60s cooldown --------------------------------------

  it('startVerification enforces per-number 60s cooldown', async () => {
    // Per-number count returns 1 (cooldown active).
    otpModel.countDocuments.mockReturnValueOnce({ exec: () => Promise.resolve(1) });

    // Combined assertion: must be a TooManyRequestsException AND carry the
    // structured `code: TOO_MANY_REQUESTS` payload the FE branches on.
    // A bare-string throw would lose the code field.
    const rejection = svc.startVerification(workspaceId, mobile, requestedBy);
    await expect(rejection).rejects.toBeInstanceOf(TooManyRequestsException);
    await expect(rejection).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }),
    });

    expect(otpModel.create).not.toHaveBeenCalled();
    expect(smsService.sendDltSms).not.toHaveBeenCalled();
  });

  // -- Test 3: per-workspace burst cap --------------------------------------

  it('startVerification enforces per-workspace 10/min cap', async () => {
    // Per-number count = 0 (no cooldown), per-workspace count = 10 (cap hit).
    otpModel.countDocuments
      .mockReturnValueOnce({ exec: () => Promise.resolve(0) }) // per-number
      .mockReturnValueOnce({ exec: () => Promise.resolve(10) }); // per-workspace

    await expect(svc.startVerification(workspaceId, mobile, requestedBy)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }),
    });

    expect(otpModel.create).not.toHaveBeenCalled();
  });

  // -- Test 4: confirmVerification succeeds + returns JWT -------------------

  it('confirmVerification succeeds with correct code and returns JWT', async () => {
    const doc = makeOtpDoc({ codeHash: 'hashed-code' });
    otpModel.findOne.mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(doc) }),
    });
    bcryptCompare.mockResolvedValue(true);

    const result = await svc.confirmVerification(workspaceId, mobile, '123456', requestedBy);

    // bcrypt.compare must be used (constant-time comparison - never string ===).
    expect(bcryptCompare).toHaveBeenCalledWith('123456', 'hashed-code');
    expect(doc.consumedAt).not.toBeNull();
    expect(doc.save).toHaveBeenCalled();
    expect(jwtService.signAsync).toHaveBeenCalledOnce();

    const jwtArg = jwtService.signAsync.mock.calls[0][0];
    expect(jwtArg).toMatchObject({
      kind: 'mobile-verify',
      workspaceId,
      mobile,
    });

    expect(result.token).toBe('signed.jwt.token');
    expect(result.expiresAt).toBeInstanceOf(Date);

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.mobile_otp_verified',
    );
    expect(auditCall).toBeDefined();

    // Phase 1f.3 — PostHog capture mirrors the audit event. distinctId is
    // the confirming user, properties carry workspaceId + mobileLast4 only.
    expect(postHogService.capture).toHaveBeenCalledWith({
      distinctId: requestedBy,
      event: 'team.mobile_otp_verified',
      properties: { workspaceId, mobileLast4: mobile.slice(-4) },
    });
  });

  // -- Test 5: wrong code increments attempts -------------------------------

  it('confirmVerification rejects wrong code and increments attempts', async () => {
    const doc = makeOtpDoc({ attempts: 0 });
    otpModel.findOne.mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(doc) }),
    });
    bcryptCompare.mockResolvedValue(false);

    // Structured-payload contract: wrong-code must carry `code: OTP_WRONG_CODE`
    // + `attempts: number` so the FE can compute remaining attempts and
    // localize the message. A bare-string throw would lose both fields.
    await expect(
      svc.confirmVerification(workspaceId, mobile, 'wrong1', requestedBy),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OTP_WRONG_CODE',
        attempts: expect.any(Number),
      }),
    });

    expect(doc.attempts).toBe(1);
    expect(doc.save).toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.mobile_otp_failed',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta.reason).toBe('wrong_code');

    // Phase 1f.3 — PostHog capture mirrors the audit-failure event. The
    // `reason` discriminator (wrong_code | expired_or_invalid | locked)
    // lands in properties so funnels can split out by failure mode.
    expect(postHogService.capture).toHaveBeenCalledWith({
      distinctId: requestedBy,
      event: 'team.mobile_otp_failed',
      properties: {
        workspaceId,
        mobileLast4: mobile.slice(-4),
        reason: 'wrong_code',
      },
    });
  });

  // -- Test 6: locks after 5 wrong attempts ---------------------------------

  it('confirmVerification locks doc after reaching MAX_ATTEMPTS', async () => {
    const doc = makeOtpDoc({ attempts: 5 });
    otpModel.findOne.mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(doc) }),
    });

    await expect(
      svc.confirmVerification(workspaceId, mobile, 'any', requestedBy),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OTP_LOCKED' }),
    });

    // Doc should be consumed (locked) on reaching max attempts.
    expect(doc.consumedAt).not.toBeNull();
    expect(doc.save).toHaveBeenCalled();
    // bcrypt.compare must NOT be called when already locked (locked == consumed).
    expect(bcryptCompare).not.toHaveBeenCalled();

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.mobile_otp_failed',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta.reason).toBe('locked');
  });

  // -- Test 7: no active OTP exists -----------------------------------------

  it('confirmVerification rejects when no active OTP exists', async () => {
    otpModel.findOne.mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(null) }),
    });

    await expect(
      svc.confirmVerification(workspaceId, mobile, '123456', requestedBy),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OTP_EXPIRED_OR_INVALID' }),
    });

    expect(jwtService.signAsync).not.toHaveBeenCalled();

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.mobile_otp_failed',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta.reason).toBe('expired_or_invalid');
  });

  // -- Test 8: already-consumed OTP (query returns null) --------------------

  it('confirmVerification rejects already-consumed OTP (query returns null)', async () => {
    // The findOne query filters consumedAt: null, so a consumed doc is excluded
    // and null is returned. Same rejection path as test 7.
    otpModel.findOne.mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(null) }),
    });

    await expect(
      svc.confirmVerification(workspaceId, mobile, '123456', requestedBy),
    ).rejects.toThrow('No active code');
  });

  // -- Test 9: assertProofToken validates a valid token ---------------------

  it('assertProofToken resolves silently for a valid token', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      kind: 'mobile-verify',
      workspaceId,
      mobile,
      confirmedBy: requestedBy,
    });

    await expect(
      svc.assertProofToken(workspaceId, mobile, 'valid.jwt.token'),
    ).resolves.toBeUndefined();
  });

  // -- Test 10: assertProofToken rejects token with wrong mobile ------------

  it('assertProofToken rejects token with wrong mobile', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      kind: 'mobile-verify',
      workspaceId,
      mobile: '911111111111', // different mobile
      confirmedBy: requestedBy,
    });

    await expect(
      svc.assertProofToken(workspaceId, mobile, 'valid.jwt.token'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OTP_PROOF_INVALID' }),
    });
  });

  // -- Test 11: assertProofToken rejects expired token ----------------------

  it('assertProofToken rejects expired/invalid token', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      svc.assertProofToken(workspaceId, mobile, 'expired.jwt.token'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OTP_PROOF_INVALID' }),
    });
  });
});
