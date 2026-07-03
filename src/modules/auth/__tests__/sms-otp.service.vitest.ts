/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
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

// Mock env so individual tests can override (mock-mode toggle, rate-limits).
const envState = {
  mockEnabled: false,
  rateLimitHourly: 5,
  rateLimitDaily: 10,
  perIpDaily: 20,
  maxVerifyAttempts: 5,
  lockoutMinutes: 30,
  expiryMs: 600_000,
  resendCooldownSec: 30,
  circuitBreakerThreshold: 25,
  circuitBreakerWindowSec: 300,
  msg91TemplateId: 'tpl_test' as string | undefined,
  msg91WorkspaceId: '5f9d5b9e9f5b9e9f5b9e9f5b' as string | undefined,
  channel: 'dlt' as 'dlt' | 'widget',
};
vi.mock('../../../config/env', () => ({
  env: {
    nodeEnv: 'test',
    systemUserId: 'system',
    jwt: { accessSecret: 's3cret', accessExpiry: '15m' },
    msg91: {
      get authOtpTemplateId() {
        return envState.msg91TemplateId;
      },
      get authOtpWorkspaceId() {
        return envState.msg91WorkspaceId;
      },
    },
    authOtp: {
      get mockEnabled() {
        return envState.mockEnabled;
      },
      mockAllowInProd: false,
      get expiryMs() {
        return envState.expiryMs;
      },
      get resendCooldownSec() {
        return envState.resendCooldownSec;
      },
      get maxVerifyAttempts() {
        return envState.maxVerifyAttempts;
      },
      get lockoutMinutes() {
        return envState.lockoutMinutes;
      },
      get rateLimitHourly() {
        return envState.rateLimitHourly;
      },
      get rateLimitDaily() {
        return envState.rateLimitDaily;
      },
      get perIpDaily() {
        return envState.perIpDaily;
      },
      get circuitBreakerThreshold() {
        return envState.circuitBreakerThreshold;
      },
      get circuitBreakerWindowSec() {
        return envState.circuitBreakerWindowSec;
      },
      get channel() {
        return envState.channel;
      },
    },
  },
}));

import { Types } from 'mongoose';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { SmsOtpService } from '../services/sms-otp.service';
import { Msg91WidgetOtpService } from '../../sms/services/msg91-widget-otp.service';
import type { VerifyOtpDto } from '../dto/sms-otp.dto';

function resetEnv(): void {
  envState.mockEnabled = false;
  envState.rateLimitHourly = 5;
  envState.rateLimitDaily = 10;
  envState.perIpDaily = 20;
  envState.maxVerifyAttempts = 5;
  envState.lockoutMinutes = 30;
  envState.expiryMs = 600_000;
  envState.resendCooldownSec = 30;
  envState.circuitBreakerThreshold = 25;
  envState.circuitBreakerWindowSec = 300;
  envState.msg91TemplateId = 'tpl_test';
  envState.msg91WorkspaceId = '5f9d5b9e9f5b9e9f5b9e9f5b';
  envState.channel = 'dlt';
}

function buildService(
  overrides: {
    user?: any;
    smsResult?: { status: 'sent' | 'failed' | 'skipped'; errorMessage?: string };
    jwtVerifyImpl?: (token: string) => any;
  } = {},
) {
  const redisStore = new Map<string, { value: string; expiresAt?: number }>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();

  const redis: any = {
    get: vi.fn(async (k: string) => redisStore.get(k)?.value ?? null),
    set: vi.fn(async (k: string, v: string, ...args: any[]) => {
      const isNx = args.includes('NX');
      const exIdx = args.indexOf('EX');
      const ttl = exIdx >= 0 ? Number(args[exIdx + 1]) : undefined;
      if (isNx && redisStore.has(k)) return null;
      redisStore.set(k, {
        value: v,
        expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
      });
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    incr: vi.fn(async (k: string) => {
      const prev = parseInt(redisStore.get(k)?.value ?? '0', 10);
      const next = prev + 1;
      redisStore.set(k, { value: String(next) });
      return next;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async (k: string) => {
      const e = redisStore.get(k)?.expiresAt;
      return e ? Math.max(1, Math.ceil((e - Date.now()) / 1000)) : -1;
    }),
    zadd: vi.fn(async (k: string, score: number, member: string) => {
      const arr = zsets.get(k) ?? [];
      arr.push({ score, member });
      zsets.set(k, arr);
      return 1;
    }),
    zcard: vi.fn(async (k: string) => zsets.get(k)?.length ?? 0),
    zremrangebyscore: vi.fn(async (k: string, _min: any, max: any) => {
      const arr = zsets.get(k) ?? [];
      const cutoff = Number(max);
      const next = arr.filter((e) => e.score > cutoff);
      const removed = arr.length - next.length;
      zsets.set(k, next);
      return removed;
    }),
    zrange: vi.fn(async (k: string) => {
      const arr = zsets.get(k) ?? [];
      if (!arr.length) return [];
      const oldest = arr.slice().sort((a, b) => a.score - b.score)[0];
      return [oldest.member, String(oldest.score)];
    }),
  };

  const users: any = {
    findByMobile: vi.fn().mockResolvedValue(overrides.user ?? null),
    findByMobileWithMobileOtpFields: vi.fn().mockResolvedValue(overrides.user ?? null),
    findByIdWithMobileOtpFields: vi.fn().mockResolvedValue(overrides.user ?? null),
    findById: vi.fn().mockResolvedValue(overrides.user ?? null),
    create: vi.fn().mockImplementation(async (payload: any) => ({
      _id: new Types.ObjectId(),
      ...payload,
    })),
    update: vi.fn().mockResolvedValue(undefined),
    // Register-flow handle backfill (UsersService.generateHandleForUser) — added
    // to the mock so the verifyOtp register path can call it without the stale
    // mock throwing. Real method slugifies the name into a unique public handle.
    generateHandleForUser: vi.fn().mockResolvedValue({ handle: 'asha-patel' }),
  };
  const sms: any = {
    sendDltSms: vi
      .fn()
      .mockResolvedValue(overrides.smsResult ?? { status: 'sent', providerMessageId: 'r1' }),
  };
  const subs: any = { createFreeSubscription: vi.fn().mockResolvedValue(undefined) };
  const config: any = {
    get: vi
      .fn()
      .mockImplementation((k: string) => (k === 'jwt.accessSecret' ? 's3cret' : undefined)),
  };
  const jwt: any = {
    signAsync: vi
      .fn()
      .mockImplementation(async (payload: any) => `signed:${JSON.stringify(payload)}`),
    verifyAsync: vi.fn().mockImplementation(async (tok: string) => {
      if (overrides.jwtVerifyImpl) return overrides.jwtVerifyImpl(tok);
      const json = tok.replace(/^signed:/, '');
      return JSON.parse(json);
    }),
  };
  const authService: any = {
    auditAuthEvent: vi.fn(),
    auditAnonOtpEvent: vi.fn(),
    // Register-flow pending-invite link-up (AuthService.linkPendingInvitations)
    // — fire-and-forget after a new user is created. Stubbed so the verifyOtp
    // register path can call it without the mock throwing.
    linkPendingInvitations: vi.fn().mockResolvedValue(undefined),
    // Connect Referral Program — best-effort signup attribution the verifyOtp
    // register branch fires after finalizeAuthSuccess. Synchronous fire-and-forget
    // (returns void); stubbed so the register path can call it without throwing.
    attachReferralBestEffort: vi.fn(),
    finalizeAuthSuccess: vi.fn().mockImplementation(async (opts: any) => ({
      accessToken: 'a',
      refreshToken: 'r',
      user: opts.user,
      isNewUser: !!opts.isNewUser,
      ...(opts.mustResetPassword ? { mustResetPassword: true } : {}),
    })),
  };
  const workspacesService: any = {
    create: vi.fn().mockImplementation(async () => ({
      _id: new Types.ObjectId(),
      name: 'Test Workspace',
    })),
  };
  if (!('remove' in users)) {
    users.remove = vi.fn().mockResolvedValue(undefined);
  }

  const postHog: any = { capture: vi.fn(), identify: vi.fn() };
  const widgetOtpServiceMock: any = { verifyAccessToken: vi.fn().mockResolvedValue(null) };

  const svc = new SmsOtpService(
    config,
    jwt,
    users,
    authService,
    subs,
    sms,
    workspacesService,
    redis,
    postHog,
    widgetOtpServiceMock,
  );
  return {
    svc,
    redis,
    redisStore,
    users,
    sms,
    subs,
    authService,
    workspacesService,
    postHog,
    widgetOtpServiceMock,
  };
}

describe('SmsOtpService.sendOtp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
  });

  it('rejects malformed mobile', async () => {
    const { svc } = buildService();
    await expect(svc.sendOtp({ mobile: '12345', flowType: 'login' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns generic success without dispatch when login-flow user does not exist (anti-enumeration)', async () => {
    const { svc, sms, authService } = buildService({ user: null });
    const res = await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    expect(res.ok).toBe(true);
    expect(sms.sendDltSms).not.toHaveBeenCalled();
    expect(authService.auditAnonOtpEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'otp_send_blocked_unknown_user' }),
    );
  });

  it('returns generic success when register-flow user already exists', async () => {
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, sms, authService } = buildService({ user });
    const res = await svc.sendOtp({ mobile: '9876543210', flowType: 'register' } as any);
    expect(res.ok).toBe(true);
    expect(sms.sendDltSms).not.toHaveBeenCalled();
    expect(authService.auditAnonOtpEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'otp_send_blocked_existing_user' }),
    );
  });

  it('mints + dispatches when login-flow user exists', async () => {
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, sms, users, authService } = buildService({ user });
    const res = await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    expect(res.mockMode).toBe(false);
    expect(sms.sendDltSms).toHaveBeenCalledWith(
      expect.objectContaining({
        mobile: '919876543210',
        templateId: 'tpl_test',
        creditSource: 'system',
      }),
    );
    expect(users.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mobileVerificationFlow: 'login' }),
    );
    expect(authService.auditAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'otp_sent' }),
    );
  });

  it('idempotency window — second send within cooldown returns idempotent: true', async () => {
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, sms } = buildService({ user });
    await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    const second = await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    expect(second.idempotent).toBe(true);
    expect(sms.sendDltSms).toHaveBeenCalledTimes(1);
  });

  it('per-phone hourly cap blocks 6th send', async () => {
    envState.rateLimitHourly = 5;
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, redisStore } = buildService({ user });
    for (let i = 0; i < 5; i += 1) {
      redisStore.delete('otp:idem:919876543210:login');
      redisStore.delete('otp:cooldown:919876543210');
      await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    }
    redisStore.delete('otp:idem:919876543210:login');
    redisStore.delete('otp:cooldown:919876543210');
    await expect(
      svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('mock mode never calls MSG91 and returns mockMode: true', async () => {
    envState.mockEnabled = true;
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, sms } = buildService({ user });
    const res = await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
    expect(sms.sendDltSms).not.toHaveBeenCalled();
    expect(res.mockMode).toBe(true);
  });

  it('SERVICE_DEGRADED — live mode + missing MSG91 template throws 503', async () => {
    envState.mockEnabled = false;
    envState.msg91TemplateId = undefined;
    const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
    const { svc, sms } = buildService({ user });
    await expect(
      svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: { code: 'SERVICE_DEGRADED' },
    });
    expect(sms.sendDltSms).not.toHaveBeenCalled();
  });

  it('SERVICE_DEGRADED — live mode + missing AUTH_OTP_WORKSPACE_ID throws 503', async () => {
    envState.mockEnabled = false;
    envState.msg91WorkspaceId = undefined;
    // Register flow requires user==null to bypass anti-enumeration and reach
    // the templateId/workspaceId guard inside mintAndDispatch.
    const { svc, sms } = buildService({ user: null });
    await expect(
      svc.sendOtp({ mobile: '9876543210', flowType: 'register' } as any),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: { code: 'SERVICE_DEGRADED' },
    });
    expect(sms.sendDltSms).not.toHaveBeenCalled();
  });

  it('register flow + mock off + missing template — fails before MSG91 call (no orphan SMS log)', async () => {
    envState.mockEnabled = false;
    envState.msg91TemplateId = undefined;
    const { svc, sms } = buildService({ user: null });
    await expect(
      svc.sendOtp({ mobile: '9876543210', flowType: 'register' } as any),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(sms.sendDltSms).not.toHaveBeenCalled();
  });

  describe('mintAndDispatch channel branching', () => {
    it('widget channel does not call sendDltSms', async () => {
      envState.channel = 'widget';
      const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
      const { svc, sms } = buildService({ user });
      await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
      expect(sms.sendDltSms).not.toHaveBeenCalled();
    });

    it('dlt channel still calls sendDltSms', async () => {
      envState.channel = 'dlt';
      const user = { _id: new Types.ObjectId(), name: 'A', mobile: '919876543210' };
      const { svc, sms } = buildService({ user });
      await svc.sendOtp({ mobile: '9876543210', flowType: 'login' } as any);
      expect(sms.sendDltSms).toHaveBeenCalled();
    });
  });
});

describe('SmsOtpService.verifyOtp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
  });

  it('OTP_NOT_REQUESTED when no stored token (login flow)', async () => {
    const user = {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileVerificationToken: null,
    };
    const { svc } = buildService({ user });
    await expect(
      svc.verifyOtp({
        mobile: '9876543210',
        otp: '123456',
        flowType: 'login',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'OTP_NOT_REQUESTED' } });
  });

  it('OTP_FLOW_MISMATCH when JWT minted for register but verify says login', async () => {
    const user: any = {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileVerificationToken: 'signed:xx',
    };
    const { svc } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '123456',
        mobile: '919876543210',
        flowType: 'register',
        type: 'mobile-otp',
      }),
    });
    await expect(
      svc.verifyOtp({
        mobile: '9876543210',
        otp: '123456',
        flowType: 'login',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'OTP_FLOW_MISMATCH' } });
  });

  it('login success → finalizeAuthSuccess called with variant=otp', async () => {
    const user: any = {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileVerificationToken: 'signed:xx',
      mobileOtpAttempts: 0,
      mobileOtpLockedUntil: null,
    };
    const { svc, authService } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '123456',
        mobile: '919876543210',
        flowType: 'login',
        type: 'mobile-otp',
      }),
    });
    const res = await svc.verifyOtp({
      mobile: '9876543210',
      otp: '123456',
      flowType: 'login',
    } as any);
    expect(authService.finalizeAuthSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        auditAction: 'login_success',
        auditMeta: expect.objectContaining({ variant: 'otp' }),
      }),
    );
    expect(res.accessToken).toBe('a');
  });

  it('forgot success → mustResetPassword: true', async () => {
    const user: any = {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileVerificationToken: 'signed:xx',
      mobileOtpAttempts: 0,
      mobileOtpLockedUntil: null,
    };
    const { svc, authService } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '123456',
        mobile: '919876543210',
        flowType: 'forgot',
        type: 'mobile-otp',
      }),
    });
    const res = await svc.verifyOtp({
      mobile: '9876543210',
      otp: '123456',
      flowType: 'forgot',
    } as any);
    expect(authService.finalizeAuthSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ mustResetPassword: true }),
    );
    expect(res.mustResetPassword).toBe(true);
  });

  it('lockout — wrong OTP at attempt 5 sets mobileOtpLockedUntil and returns 423', async () => {
    envState.maxVerifyAttempts = 5;
    const user: any = {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileVerificationToken: 'signed:xx',
      mobileOtpAttempts: 4,
      mobileOtpLockedUntil: null,
    };
    const { svc, users } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '999999',
        mobile: '919876543210',
        flowType: 'login',
        type: 'mobile-otp',
      }),
    });
    // attemptsRemaining() refetches via findByIdWithMobileOtpFields after the
    // bump persists. Mirror that contract so the post-bump read sees the new
    // count and triggers the LOCKED branch.
    users.findByIdWithMobileOtpFields = vi
      .fn()
      .mockResolvedValue({ ...user, mobileOtpAttempts: 5 });
    await expect(
      svc.verifyOtp({
        mobile: '9876543210',
        otp: '111111',
        flowType: 'login',
      } as any),
    ).rejects.toMatchObject({ status: HttpStatus.LOCKED });
    expect(users.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mobileOtpLockedUntil: expect.any(Date) }),
    );
  });

  it('register success creates user, assigns free subscription, marks isMobileVerified', async () => {
    envState.mockEnabled = true;
    const { svc, users, subs, authService, redisStore } = buildService({
      user: null,
      jwtVerifyImpl: () => ({
        otp: '123456',
        mobile: '919876543210',
        flowType: 'register',
        type: 'mobile-otp',
      }),
    });
    redisStore.set('pending-otp:919876543210:register', { value: 'signed:xx' });
    await svc.verifyOtp({
      mobile: '9876543210',
      otp: '123456',
      flowType: 'register',
      name: 'New User',
    } as any);
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '919876543210', isMobileVerified: true }),
    );
    expect(subs.createFreeSubscription).toHaveBeenCalled();
    expect(authService.finalizeAuthSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ auditAction: 'register_success', isNewUser: true }),
    );
  });

  describe('matchOtp — widget channel verification', () => {
    it('verifyOtp accepts a valid widget accessToken', async () => {
      envState.channel = 'widget';
      envState.mockEnabled = true;
      const { svc, redisStore, widgetOtpServiceMock } = buildService({
        user: null,
        jwtVerifyImpl: () => ({
          otp: '000000',
          mobile: '919876543210',
          flowType: 'register',
          type: 'mobile-otp',
          channel: 'widget',
        }),
      });
      redisStore.set('pending-otp:919876543210:register', { value: 'signed:xx' });

      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce({
        mobile: '919876543210',
      });

      const result = await svc.verifyOtp({
        mobile: '9876543210',
        accessToken: 'good-token',
        flowType: 'register',
        name: 'Test User',
        password: 'password123',
      } as VerifyOtpDto);

      expect(result).toBeDefined();
      expect(widgetOtpServiceMock.verifyAccessToken).toHaveBeenCalledWith('good-token');
    });

    it('verifyOtp rejects when Msg91WidgetOtpService returns null', async () => {
      envState.channel = 'widget';
      envState.mockEnabled = true;
      const { svc, redisStore, widgetOtpServiceMock } = buildService({
        user: null,
        jwtVerifyImpl: () => ({
          otp: '000000',
          mobile: '919876543210',
          flowType: 'register',
          type: 'mobile-otp',
          channel: 'widget',
        }),
      });
      redisStore.set('pending-otp:919876543210:register', { value: 'signed:xx' });

      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce(null);

      await expect(
        svc.verifyOtp({
          mobile: '9876543210',
          accessToken: 'bad-token',
          flowType: 'register',
          name: 'Test User',
          password: 'password123',
        } as VerifyOtpDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('SmsOtpService.sendMobileVerifyOtp + verifyMobile (pattern A — Redis pending-verify)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
  });

  it('sendMobileVerifyOtp does NOT write user.mobile and stores OTP-JWT in Redis pending-verify slot', async () => {
    const userId = new Types.ObjectId();
    const user = { _id: userId, name: 'A', mobile: undefined, isMobileVerified: false };
    const { svc, redisStore, users } = buildService({ user });
    await svc.sendMobileVerifyOtp(userId.toString(), { mobile: '9876543210' });
    // Pending-verify Redis key is set
    const pendingKey = `pending-verify:mobile:${userId.toString()}`;
    expect(redisStore.has(pendingKey)).toBe(true);
    // No User update with the candidate `mobile` field
    const mobileWrites = users.update.mock.calls.filter(
      (call: any[]) => call[1] && Object.prototype.hasOwnProperty.call(call[1], 'mobile'),
    );
    expect(mobileWrites).toHaveLength(0);
  });

  it('verifyMobile reads JWT from Redis and calls claimMobileVerified atomically', async () => {
    const userId = new Types.ObjectId();
    const user = { _id: userId, name: 'A', mobile: undefined, isMobileVerified: false };
    const { svc, redisStore, users } = buildService({ user });
    users.claimMobileVerified = vi
      .fn()
      .mockResolvedValue({ ...user, mobile: '919876543210', isMobileVerified: true });
    // Stage a Redis JWT as if sendMobileVerifyOtp had run
    const pendingKey = `pending-verify:mobile:${userId.toString()}`;
    redisStore.set(pendingKey, {
      value: `signed:${JSON.stringify({
        otp: '123456',
        mobile: '919876543210',
        flowType: 'verify',
        type: 'mobile-otp',
      })}`,
    });
    await svc.verifyMobile(userId.toString(), { otp: '123456' });
    expect(users.claimMobileVerified).toHaveBeenCalledWith(userId.toString(), '919876543210');
    // Pending-verify key cleaned up after success
    expect(redisStore.has(pendingKey)).toBe(false);
  });

  it('verifyMobile returns OTP_NOT_REQUESTED when Redis pending-verify slot is absent', async () => {
    const userId = new Types.ObjectId();
    const user = { _id: userId, name: 'A', isMobileVerified: false };
    const { svc } = buildService({ user });
    await expect(
      svc.verifyMobile(userId.toString(), { otp: '123456' } as any),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'OTP_NOT_REQUESTED' }) });
  });

  it('sendMobileVerifyOtp throws MOBILE_LOCKED when verified mobile would change', async () => {
    const userId = new Types.ObjectId();
    const user = {
      _id: userId,
      name: 'A',
      mobile: '919999999999',
      isMobileVerified: true,
    };
    const { svc } = buildService({ user });
    await expect(
      svc.sendMobileVerifyOtp(userId.toString(), { mobile: '9876543210' } as any),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MOBILE_LOCKED' }) });
  });

  describe('matchOtp — widget channel verification', () => {
    it('verifyMobile accepts a valid widget accessToken', async () => {
      const userId = new Types.ObjectId();
      const user = { _id: userId, name: 'A', mobile: undefined, isMobileVerified: false };
      const { svc, redisStore, users, widgetOtpServiceMock } = buildService({ user });
      users.claimMobileVerified = vi
        .fn()
        .mockResolvedValue({ ...user, mobile: '919876543210', isMobileVerified: true });
      const pendingKey = `pending-verify:mobile:${userId.toString()}`;
      redisStore.set(pendingKey, {
        value: `signed:${JSON.stringify({
          otp: '000000',
          mobile: '919876543210',
          flowType: 'verify',
          type: 'mobile-otp',
          channel: 'widget',
        })}`,
      });
      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce({ mobile: '919876543210' });

      await svc.verifyMobile(userId.toString(), { accessToken: 'good-token' } as any);

      expect(widgetOtpServiceMock.verifyAccessToken).toHaveBeenCalledWith('good-token');
      expect(users.claimMobileVerified).toHaveBeenCalledWith(userId.toString(), '919876543210');
    });

    it('verifyMobile rejects when Msg91WidgetOtpService returns null', async () => {
      const userId = new Types.ObjectId();
      const user = { _id: userId, name: 'A', mobile: undefined, isMobileVerified: false };
      const { svc, redisStore, widgetOtpServiceMock } = buildService({ user });
      const pendingKey = `pending-verify:mobile:${userId.toString()}`;
      redisStore.set(pendingKey, {
        value: `signed:${JSON.stringify({
          otp: '000000',
          mobile: '919876543210',
          flowType: 'verify',
          type: 'mobile-otp',
          channel: 'widget',
        })}`,
      });
      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce(null);

      await expect(
        svc.verifyMobile(userId.toString(), { accessToken: 'bad-token' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

// ── Account-deletion Phase 1 — stepup OTP flow ───────────────────────────────
// A new authenticated `stepup` flowType used ONLY to confirm the delete action:
// it verifies an OTP bound to the logged-in user and returns a SINGLE-USE,
// short-lived proof token. It mints NO session and never calls
// finalizeAuthSuccess (Plan §A.3).
describe('SmsOtpService stepup (account-deletion Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
    envState.mockEnabled = true; // deterministic OTP = 123456
  });

  function stepupUser() {
    return {
      _id: new Types.ObjectId(),
      name: 'Asha Patel',
      mobile: '9876543210',
      isActive: true,
      isMobileVerified: true,
    };
  }

  it('sendStepupOtp dispatches an OTP for the authenticated user and stages it keyed by userId', async () => {
    const user = stepupUser();
    const userId = user._id.toString();
    const { svc, redisStore } = buildService({ user });

    const res = await svc.sendStepupOtp(userId);

    expect(res.ok).toBe(true);
    // Staged in a dedicated per-user Redis slot (NOT on the User row's
    // login/forgot token), so it can't be replayed as a login OTP.
    expect(redisStore.has(`stepup-otp:${userId}`)).toBe(true);
  });

  it('verifyStepupOtp returns a single-use proof token and mints NO session', async () => {
    const user = stepupUser();
    const userId = user._id.toString();
    const { svc, authService } = buildService({ user });

    await svc.sendStepupOtp(userId);
    const res = await svc.verifyStepupOtp(userId, '123456');

    expect(res.ok).toBe(true);
    expect(typeof res.proofToken).toBe('string');
    expect(res.proofToken.length).toBeGreaterThanOrEqual(32);
    // The whole point: a confirm-this-action factor, NOT a login.
    expect(authService.finalizeAuthSuccess).not.toHaveBeenCalled();
  });

  it('the proof token is single-use — consumeStepupProof succeeds once then fails', async () => {
    const user = stepupUser();
    const userId = user._id.toString();
    const { svc } = buildService({ user });

    await svc.sendStepupOtp(userId);
    const { proofToken } = await svc.verifyStepupOtp(userId, '123456');

    expect(await svc.consumeStepupProof(userId, proofToken)).toBe(true);
    // Second consume fails — the nonce was burned (replay defence, §5).
    expect(await svc.consumeStepupProof(userId, proofToken)).toBe(false);
  });

  it('rejects a wrong OTP and mints no proof', async () => {
    const user = stepupUser();
    const userId = user._id.toString();
    const { svc, authService } = buildService({ user });

    await svc.sendStepupOtp(userId);
    await expect(svc.verifyStepupOtp(userId, '000000')).rejects.toBeInstanceOf(BadRequestException);

    expect(authService.finalizeAuthSuccess).not.toHaveBeenCalled();
    expect(await svc.consumeStepupProof(userId, 'whatever-proof-value')).toBe(false);
  });

  describe('matchOtp — widget channel verification', () => {
    it('verifyStepupOtp accepts a valid widget accessToken', async () => {
      const user = stepupUser();
      const userId = user._id.toString();
      const { svc, redisStore, widgetOtpServiceMock } = buildService({ user });
      const pendingKey = `stepup-otp:${userId}`;
      redisStore.set(pendingKey, {
        value: `signed:${JSON.stringify({
          otp: '000000',
          mobile: '9876543210',
          flowType: 'stepup',
          type: 'mobile-otp',
          channel: 'widget',
        })}`,
      });
      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce({ mobile: '9876543210' });

      const res = await svc.verifyStepupOtp(userId, undefined, 'good-token');

      expect(res.ok).toBe(true);
      expect(widgetOtpServiceMock.verifyAccessToken).toHaveBeenCalledWith('good-token');
    });

    it('verifyStepupOtp rejects when Msg91WidgetOtpService returns null', async () => {
      const user = stepupUser();
      const userId = user._id.toString();
      const { svc, redisStore, widgetOtpServiceMock } = buildService({ user });
      const pendingKey = `stepup-otp:${userId}`;
      redisStore.set(pendingKey, {
        value: `signed:${JSON.stringify({
          otp: '000000',
          mobile: '9876543210',
          flowType: 'stepup',
          type: 'mobile-otp',
          channel: 'widget',
        })}`,
      });
      widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce(null);

      await expect(
        svc.verifyStepupOtp(userId, undefined, 'bad-token'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

// ── terminateAndOtpLogin — widget channel verification ──────────────────────
describe('SmsOtpService.terminateAndOtpLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
  });

  function loginUser() {
    return {
      _id: new Types.ObjectId(),
      name: 'A',
      mobile: '919876543210',
      isActive: true,
      mobileOtpAttempts: 0,
      mobileOtpLockedUntil: null,
    };
  }

  it('accepts a valid widget accessToken and terminates + logs in', async () => {
    const user: any = { ...loginUser(), mobileVerificationToken: 'signed:xx' };
    const { svc, authService, widgetOtpServiceMock } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '000000',
        mobile: '919876543210',
        flowType: 'login',
        type: 'mobile-otp',
        channel: 'widget',
      }),
    });
    widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce({ mobile: '919876543210' });

    const res = await svc.terminateAndOtpLogin({
      mobile: '9876543210',
      accessToken: 'good-token',
      sessionId: 'sess1',
    } as any);

    expect(widgetOtpServiceMock.verifyAccessToken).toHaveBeenCalledWith('good-token');
    expect(authService.finalizeAuthSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ terminateSessionId: 'sess1' }),
    );
    expect(res.accessToken).toBe('a');
  });

  it('rejects when Msg91WidgetOtpService returns null', async () => {
    const user: any = { ...loginUser(), mobileVerificationToken: 'signed:xx' };
    const { svc, widgetOtpServiceMock } = buildService({
      user,
      jwtVerifyImpl: () => ({
        otp: '000000',
        mobile: '919876543210',
        flowType: 'login',
        type: 'mobile-otp',
        channel: 'widget',
      }),
    });
    widgetOtpServiceMock.verifyAccessToken.mockResolvedValueOnce(null);

    await expect(
      svc.terminateAndOtpLogin({
        mobile: '9876543210',
        accessToken: 'bad-token',
        sessionId: 'sess1',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
