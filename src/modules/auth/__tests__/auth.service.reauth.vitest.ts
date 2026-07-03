/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AuthService so the transitive
// schema imports don't trip vitest's reflect-metadata pipeline (mirrors
// auth.service.audit.vitest.ts). Models are injected as plain mocks.
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
import { UnauthorizedException } from '@nestjs/common';

/**
 * AuthService.assertReauthenticated (account-deletion Phase 2, plan §5/§A.11).
 *
 * Re-auth factor for a sensitive self-action (whole-account deletion). Mirrors
 * forgotPinCredentialVerify's password/Google branch + adds the OTP-only
 * fallback: an account with neither a password nor a Google link needs no
 * separate re-auth here (the step-up OTP proof, validated by the caller, is the
 * factor). It throws on a missing/invalid factor and resolves silently on pass.
 */
describe('AuthService.assertReauthenticated (Phase 2 sensitive-action re-auth)', () => {
  let usersService: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let svc: AuthService;

  const userId = new Types.ObjectId().toString();

  beforeEach(() => {
    bcryptCompare.mockReset();
    usersService = { findByIdWithCredentials: vi.fn() };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const stub = () => vi.fn();
    svc = new AuthService(
      usersService,
      { sign: stub(), signAsync: stub(), verify: stub(), decode: stub() } as any,
      { get: vi.fn().mockReturnValue('test-secret') } as any,
      {} as any, // mailService
      {} as any, // subscriptionsService
      {} as any, // sessionsService
      { get: vi.fn() } as any, // moduleRef
      auditService as any,
      { get: stub(), set: stub() } as any, // redis
      {} as any, // workspacesService
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
    );
  });

  const settle = () => new Promise((r) => setImmediate(r));

  it('throws when the user does not exist', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue(null);
    await expect(
      svc.assertReauthenticated(userId, { kind: 'password', password: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ── password accounts ─────────────────────────────────────────────────────

  it('password account: resolves when the password is correct', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: '$2a$12$hash',
    });
    bcryptCompare.mockResolvedValue(true);

    await expect(
      svc.assertReauthenticated(userId, { kind: 'password', password: 'correct' }),
    ).resolves.toBeUndefined();
    expect(bcryptCompare).toHaveBeenCalledWith('correct', '$2a$12$hash');
  });

  it('password account: rejects (400) when no password is supplied', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: '$2a$12$hash',
    });

    await expect(svc.assertReauthenticated(userId, { kind: 'password' })).rejects.toMatchObject({
      response: { code: 'REAUTH_PASSWORD_REQUIRED' },
    });
    // No password supplied → never reach the hash compare.
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it('password account: rejects (401) + audits failure on a wrong password', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: '$2a$12$hash',
    });
    bcryptCompare.mockResolvedValue(false);

    await expect(
      svc.assertReauthenticated(userId, { kind: 'password', password: 'wrong' }),
    ).rejects.toMatchObject({ response: { code: 'REAUTH_INVALID' } });

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'reauth_failure',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({ kind: 'password' });
  });

  // ── Google-only accounts ──────────────────────────────────────────────────

  it('google-only account: resolves when the Google token resolves to the linked sub', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: null,
      googleId: 'google-sub-123',
    });
    (svc as any).resolveGoogleIdentity = vi.fn().mockResolvedValue({ sub: 'google-sub-123' });

    await expect(
      svc.assertReauthenticated(userId, { kind: 'google', googleIdToken: 'tok' }),
    ).resolves.toBeUndefined();
  });

  it('google-only account: rejects (400) when no Google token is supplied', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: null,
      googleId: 'google-sub-123',
    });

    await expect(svc.assertReauthenticated(userId, { kind: 'google' })).rejects.toMatchObject({
      response: { code: 'REAUTH_GOOGLE_REQUIRED' },
    });
  });

  it('google-only account: rejects (401) when the token resolves to a different sub', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: null,
      googleId: 'google-sub-123',
    });
    (svc as any).resolveGoogleIdentity = vi.fn().mockResolvedValue({ sub: 'someone-else' });

    await expect(
      svc.assertReauthenticated(userId, { kind: 'google', googleIdToken: 'tok' }),
    ).rejects.toMatchObject({ response: { code: 'REAUTH_INVALID' } });
  });

  // ── OTP-only accounts (no password, no Google) — the password-less path ─────

  it('OTP-only account: resolves with NO separate re-auth factor (step-up OTP is the factor)', async () => {
    usersService.findByIdWithCredentials.mockResolvedValue({
      _id: userId,
      name: 'Asha',
      passwordHash: null,
      googleId: null,
    });

    // Even with reauth omitted entirely, an OTP-only account passes here.
    await expect(svc.assertReauthenticated(userId, undefined)).resolves.toBeUndefined();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });
});
