/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
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

import { Types } from 'mongoose';
import { AuthService } from '../auth.service';
import { BadRequestException } from '@nestjs/common';

/**
 * Option B (ACCOUNT-DELETION plan §9) — re-signup during the 30-day grace.
 *
 * The email/password `register` path is the one signup entry that reveals
 * account existence ("User with these credentials already exists"). When the
 * conflicting identifier belongs to a whole-account (Scope-3) deletion still in
 * its grace window, that conflict must become the friendly
 * `ACCOUNT_SCHEDULED_FOR_DELETION` notice instead — so a user who deleted then
 * changed their mind learns they can recover, rather than hitting a dead end.
 * A normal active account keeps the unchanged generic conflict.
 */
describe('AuthService.register — Option B re-signup during deletion grace', () => {
  let usersService: any;
  let svc: AuthService;

  beforeEach(() => {
    usersService = {
      findByIdentifierWithCredentials: vi.fn().mockResolvedValue(null),
    };
    const configService = { get: vi.fn().mockReturnValue('test-secret') };

    svc = new AuthService(
      usersService,
      {} as any, // jwtService
      configService as any,
      {} as any, // mailService
      {} as any, // subscriptionsService
      {} as any, // sessionsService
      {} as any, // moduleRef
      {} as any, // auditService
      {} as any, // redis
      {} as any, // workspacesService
      {} as any, // postHog
      {} as any, // referralService
    );
  });

  function payload(overrides: Partial<any> = {}) {
    return { name: 'Test', email: 'gone@example.com', password: 'pwd12345', ...overrides };
  }

  it('surfaces ACCOUNT_SCHEDULED_FOR_DELETION when the identifier is a suspended (pending) account', async () => {
    const purgeAfter = new Date('2026-07-25T10:00:00.000Z');
    usersService.findByIdentifierWithCredentials.mockResolvedValue({
      _id: new Types.ObjectId(),
      passwordHash: 'hash',
      accountDeletion: { state: 'pending', purgeAfter },
    });

    await expect(svc.register(payload())).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SCHEDULED_FOR_DELETION' },
    });
    expect(usersService.findByIdentifierWithCredentials).toHaveBeenCalled();
  });

  it('shows the deletion notice even for a password-less (Google-linked) pending account', async () => {
    // Pending check runs BEFORE the "linked to Google" branch, so a Google-only
    // account in grace still gets the recover-it message (not "sign in with Google").
    usersService.findByIdentifierWithCredentials.mockResolvedValue({
      _id: new Types.ObjectId(),
      passwordHash: null,
      googleId: 'g-123',
      accountDeletion: { state: 'pending', purgeAfter: new Date('2026-07-25T10:00:00.000Z') },
    });

    await expect(svc.register(payload())).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SCHEDULED_FOR_DELETION' },
    });
  });

  it('keeps the generic "already exists" conflict for a normal active account', async () => {
    usersService.findByIdentifierWithCredentials.mockResolvedValue({
      _id: new Types.ObjectId(),
      passwordHash: 'hash',
    });

    const err = await svc.register(payload()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse();
    expect(body).toMatchObject({ message: 'User with these credentials already exists' });
    // Crucially NOT the deletion code — a live account is the ordinary conflict.
    expect((body as Record<string, unknown>).code).toBeUndefined();
  });
});
