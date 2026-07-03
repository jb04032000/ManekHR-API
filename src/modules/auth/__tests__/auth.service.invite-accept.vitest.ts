/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
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

vi.mock('bcryptjs', () => ({
  compare: vi.fn(),
  genSalt: vi.fn().mockResolvedValue('salt'),
  hash: vi.fn().mockResolvedValue('hashed-pwd'),
  default: {
    compare: vi.fn(),
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockResolvedValue('hashed-pwd'),
  },
}));

import * as crypto from 'crypto';
import { Types } from 'mongoose';
import { AuthService } from '../auth.service';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Wave 4.8 (2026-05-10) — atomic signup-and-accept-invite (email path).
 *
 * Verifies the new `inviteToken` branch on `AuthService.register`:
 *   - Mutex with `workspace` field — both set rejects with INVALID_SIGNUP_VARIANT.
 *   - Pre-flight token validation (invalid / expired / mismatched identifier).
 *   - Happy path: User created → `joinWithToken` called → fresh User refetch.
 *   - Compensating User-delete on join failure (no orphan User row).
 */
describe('AuthService.register — Wave 4.8 invite-accept (email path)', () => {
  let usersService: any;
  let jwtService: any;
  let configService: any;
  let mailService: any;
  let subscriptionsService: any;
  let sessionsService: any;
  let moduleRef: any;
  let auditService: any;
  let redis: any;
  let workspacesService: any;
  let postHog: any;
  let svc: AuthService;

  // Shared mock invite row + memberModel — exposed via WorkspacesService['memberModel']
  // (the bracket-string indexing path the implementation uses).
  let inviteRow: any;
  let memberModel: { findOne: ReturnType<typeof vi.fn> };

  const userId = new Types.ObjectId();
  const inviteId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();
  const RAW_TOKEN = 'a'.repeat(64);
  const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

  beforeEach(() => {
    inviteRow = {
      _id: inviteId,
      workspaceId,
      inviteTokenHash: TOKEN_HASH,
      inviteExpiry: new Date(Date.now() + 60 * 60 * 1000), // +1h
      inviteeIdentifier: 'invitee@example.com',
      inviteeType: 'email',
      status: 'invited',
    };

    memberModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(inviteRow) }),
    };

    usersService = {
      findByIdentifierWithCredentials: vi.fn().mockResolvedValue(null),
      findByIdentifier: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      // register() calls generateHandleForUser (auth.service.ts:433) on the
      // happy path; stub it so the register flow does not throw. Pre-existing
      // mock gap, unrelated to sessions.
      generateHandleForUser: vi.fn().mockResolvedValue(undefined),
      findByIdWithCredentials: vi.fn().mockResolvedValue({
        _id: userId,
        name: 'Test',
        email: 'invitee@example.com',
        toObject() {
          return { _id: userId, name: 'Test', email: 'invitee@example.com' };
        },
      }),
      findByGoogleId: vi.fn(),
      findOneByFilter: vi.fn(),
      findByIdWithEmailToken: vi.fn(),
      findByIdWithPinFields: vi.fn().mockResolvedValue(null),
      findManyWithResetTokenAndExpiry: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        _id: userId,
        name: 'Test',
        email: 'invitee@example.com',
        toObject() {
          return { _id: userId, name: 'Test', email: 'invitee@example.com' };
        },
      }),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    jwtService = {
      verify: vi.fn(),
      decode: vi.fn(),
      signAsync: vi.fn(),
      sign: vi.fn().mockReturnValue('fake.jwt.token'),
    };
    configService = { get: vi.fn().mockReturnValue('test-secret') };
    mailService = {
      sendUserVerificationEmail: vi.fn(),
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
    };
    moduleRef = { get: vi.fn() };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

    workspacesService = {
      // Bracket-indexed access pattern in implementation
      memberModel,
      joinWithToken: vi.fn().mockResolvedValue({
        workspace: { _id: workspaceId, name: 'Test WS' },
        member: inviteRow,
      }),
    };

    postHog = { capture: vi.fn(), identify: vi.fn() };

    svc = new AuthService(
      usersService,
      jwtService,
      configService,
      mailService,
      subscriptionsService,
      sessionsService,
      moduleRef,
      auditService,
      redis,
      workspacesService,
      postHog,
      // Connect Referral Program — best-effort signup attribution. Stubbed to a
      // resolved no-op so register's fire-and-forget call never throws.
      { attachReferralAtSignup: vi.fn().mockResolvedValue(undefined) } as any,
    );

    // Stub the email-OTP consumer to a no-op success.
    (svc as any).consumeEmailRegistrationOtp = vi.fn().mockResolvedValue(undefined);
    // linkPendingInvitations runs after the workspace branch — stub to no-op.
    (svc as any).linkPendingInvitations = vi.fn().mockResolvedValue(undefined);
  });

  function basePayload(overrides: Partial<any> = {}) {
    return {
      name: 'Test',
      email: 'invitee@example.com',
      password: 'pwd123',
      emailOtp: '123456',
      inviteToken: RAW_TOKEN,
      ...overrides,
    };
  }

  it('rejects when both inviteToken and workspace are set', async () => {
    await expect(
      svc.register(
        basePayload({
          workspace: { name: 'New WS' },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when invite token is unknown', async () => {
    memberModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });
    await expect(svc.register(basePayload())).rejects.toBeInstanceOf(BadRequestException);
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('rejects with 410 GONE when invite is expired', async () => {
    inviteRow.inviteExpiry = new Date(Date.now() - 60 * 1000);
    await expect(svc.register(basePayload())).rejects.toMatchObject({
      status: HttpStatus.GONE,
    });
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('rejects when registering email does not match invite identifier', async () => {
    inviteRow.inviteeIdentifier = 'someone-else@example.com';
    await expect(svc.register(basePayload())).rejects.toBeInstanceOf(BadRequestException);
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('rejects email-path register when invite was sent to a phone number', async () => {
    inviteRow.inviteeType = 'mobile';
    inviteRow.inviteeIdentifier = '919999999999';
    await expect(svc.register(basePayload())).rejects.toBeInstanceOf(BadRequestException);
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('happy path — creates user, calls joinWithToken, no compensating delete', async () => {
    await svc.register(basePayload());

    expect(usersService.create).toHaveBeenCalled();
    expect(workspacesService.joinWithToken).toHaveBeenCalledWith(RAW_TOKEN, userId.toString());
    expect(usersService.remove).not.toHaveBeenCalled();
    expect(usersService.findByIdWithCredentials).toHaveBeenCalled();
  });

  it('compensates by removing the User when joinWithToken fails', async () => {
    workspacesService.joinWithToken.mockRejectedValueOnce(new HttpException('boom', 500));

    await expect(svc.register(basePayload())).rejects.toBeInstanceOf(HttpException);

    expect(usersService.create).toHaveBeenCalled();
    expect(usersService.remove).toHaveBeenCalledWith(userId.toString());
  });

  it('does not invoke joinWithToken when neither inviteToken nor workspace are set (legacy register)', async () => {
    await svc.register({
      name: 'Test',
      email: 'invitee@example.com',
      password: 'pwd123',
    });

    expect(workspacesService.joinWithToken).not.toHaveBeenCalled();
    expect(usersService.create).toHaveBeenCalled();
  });
});

/**
 * H1a (2026-05-16) — `linkPendingInvitations` fires an in-app invite
 * notification for each freshly-bound invite, closing the cold-invitee
 * notification loop. The dispatcher is resolved via ModuleRef so the
 * AuthService constructor signature stays unchanged.
 */
describe('AuthService.linkPendingInvitations — H1a in-app notify on bind', () => {
  const userId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();

  function buildService(members: any[]) {
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    // `.find().populate().populate().populate().exec()` — self-returning chain.
    const memberChain: any = {
      find: vi.fn(),
      populate: vi.fn(),
      exec: vi.fn().mockResolvedValue(members),
    };
    memberChain.find.mockReturnValue(memberChain);
    memberChain.populate.mockReturnValue(memberChain);

    const moduleRef = {
      // The model token is a string ('WorkspaceMemberModel' — see the
      // @nestjs/mongoose mock); the dispatcher token is the class. Branch on
      // type so the one mock serves both moduleRef.get calls.
      get: vi.fn((token: unknown) => (typeof token === 'string' ? memberChain : dispatcher)),
    };
    const configService = { get: vi.fn().mockReturnValue('https://test') };

    const svc = new AuthService(
      {} as any, // usersService
      {} as any, // jwtService
      configService as any,
      {} as any, // mailService
      {} as any, // subscriptionsService
      {} as any, // sessionsService
      moduleRef as any,
      {} as any, // auditService
      {} as any, // redis
      {} as any, // workspacesService
      {} as any, // postHog
      { attachReferralAtSignup: vi.fn().mockResolvedValue(undefined) } as any, // referralService
    );
    return { svc, dispatcher };
  }

  function buildMember() {
    return {
      _id: new Types.ObjectId(),
      userId: null as any,
      workspaceId: { _id: workspaceId, name: 'Acme Workshop' },
      roleId: { name: 'Manager' },
      invitedBy: { name: 'Owner' },
      inviteToken: 'tok-123',
      inviteeIdentifier: 'invitee@example.com',
      inviteeType: 'email',
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('binds the invite and dispatches an in-app notification', async () => {
    const member = buildMember();
    const { svc, dispatcher } = buildService([member]);

    await svc.linkPendingInvitations(userId.toString(), 'invitee@example.com');

    expect(member.save).toHaveBeenCalledTimes(1);
    expect(String(member.userId)).toBe(userId.toString());
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeUserId: userId.toString(),
        workspaceName: 'Acme Workshop',
        role: 'Manager',
        inviterName: 'Owner',
        channels: ['in_app'],
      }),
    );
  });

  it('does not dispatch when there are no pending invites', async () => {
    const { svc, dispatcher } = buildService([]);
    await svc.linkPendingInvitations(userId.toString(), 'invitee@example.com');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('still binds the invite when the notification dispatch throws', async () => {
    const member = buildMember();
    const { svc, dispatcher } = buildService([member]);
    dispatcher.dispatch.mockRejectedValueOnce(new Error('notify boom'));

    await expect(
      svc.linkPendingInvitations(userId.toString(), 'invitee@example.com'),
    ).resolves.toBeUndefined();
    expect(member.save).toHaveBeenCalledTimes(1);
  });
});
