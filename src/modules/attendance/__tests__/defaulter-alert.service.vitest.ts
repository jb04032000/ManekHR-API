/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing DefaulterAlertService so
// that transitive schema imports (TeamMember, User, etc.) don't trip vitest's
// esbuild reflect-metadata pipeline.
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
import {
  DefaulterAlertService,
  type DispatchInput,
  type DefaulterRow,
} from '../defaulter-alert.service';

// ── Helper: build a chainable find() mock ────────────────────────────────────
// After Fix 2 the service uses teamMemberModel.find(...).select(...).lean().exec()
// instead of findById(). This helper returns a mock that satisfies that chain.
function makeFindChain(resolvedValue: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(resolvedValue),
  };
}

describe('DefaulterAlertService — resolveRecipientUserIds', () => {
  // Shared fixtures
  const workspaceId = new Types.ObjectId();
  const ownerId = new Types.ObjectId().toString();
  const recipientId1 = new Types.ObjectId().toString();
  const recipientId2 = new Types.ObjectId().toString();
  const managerId = new Types.ObjectId().toString();
  const managerMemberId = new Types.ObjectId();
  const memberObjId = new Types.ObjectId();

  const defaulterRow: DefaulterRow = {
    memberId: memberObjId.toString(),
    name: 'Test Worker',
    designation: 'Weaver',
    attendanceRate: 55,
  };

  let notificationsService: any;
  let mailService: any;
  let auditService: any;
  let teamMemberModel: any;
  let userModel: any;
  let svc: DefaulterAlertService;

  const settle = () => new Promise((r) => setImmediate(r));

  // Build a base DispatchInput for each test to clone/override.
  const baseInput = (): DispatchInput => ({
    workspace: { _id: workspaceId.toString(), ownerId },
    month: 4,
    year: 2026,
    thresholdPct: 75,
    defaulters: [defaulterRow],
    config: {
      channels: { inApp: true, email: false },
      recipients: { mode: 'specificPeople', specificPeople: [recipientId1, recipientId2] },
    },
  });

  beforeEach(() => {
    notificationsService = {
      createNotification: vi.fn().mockResolvedValue({}),
    };

    // After Fix 1: mailService now exposes sendDefaulterAlertEmail directly.
    // Tests that exercise the email channel assert on that method, not on the
    // private mailerService cast.
    mailService = {
      checkEmailQuota: vi.fn().mockResolvedValue({ allowed: false, reason: 'No quota' }),
      incrementEmailUsage: vi.fn().mockResolvedValue(undefined),
      sendDefaulterAlertEmail: vi.fn().mockResolvedValue(undefined),
    };

    auditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    // After Fix 2: the service calls teamMemberModel.find(...).select(...).lean().exec()
    // instead of findById(). Default: returns empty array (no members found → owner fallback).
    teamMemberModel = {
      find: vi.fn().mockReturnValue(makeFindChain([])),
    };

    userModel = {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      }),
    };

    svc = new DefaulterAlertService(
      notificationsService,
      mailService,
      auditService,
      teamMemberModel,
      userModel,
    );
  });

  // ── Test 1: specificPeople mode ───────────────────────────────────────────
  it('mode specificPeople — resolves exactly the configured userIds', async () => {
    const input = baseInput();
    input.config.recipients = {
      mode: 'specificPeople',
      specificPeople: [recipientId1, recipientId2],
    };

    const result = await svc.dispatch(input);

    // Both configured recipients should have been attempted
    expect(result.recipientCount).toBe(2);
    // In-app notifications should have been sent (email is off in baseInput)
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(2);
    const calls = notificationsService.createNotification.mock.calls as any[][];
    const sentTo = new Set(calls.map((c) => c[1].recipientId as string));
    expect(sentTo.has(recipientId1)).toBe(true);
    expect(sentTo.has(recipientId2)).toBe(true);
  });

  // ── Test 2: managers mode with no reportsTo → fallback to owner ──────────
  it('mode managers with no resolvable manager — falls back to workspace owner', async () => {
    const input = baseInput();
    input.config.channels = { inApp: true, email: false };
    input.config.recipients = { mode: 'managers', specificPeople: [] };

    // First find() call (defaulter members): returns the defaulter doc with no reportsTo
    // Second find() call (manager members): never reached — but if called, returns []
    teamMemberModel.find
      .mockReturnValueOnce(
        // Query for defaulter TeamMembers — doc has no reportsTo → triggers owner fallback
        makeFindChain([{ _id: memberObjId, reportsTo: null, linkedUserId: null }]),
      )
      .mockReturnValue(makeFindChain([]));

    const result = await svc.dispatch(input);

    // Only the owner should have received the notification
    expect(result.recipientCount).toBe(1);
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(1);
    const call = notificationsService.createNotification.mock.calls[0] as any[];
    expect(call[1].recipientId).toBe(ownerId);
  });

  // ── Test 3: managers mode with valid reportsTo chain ─────────────────────
  it('mode managers — resolves manager userId from reportsTo chain', async () => {
    const input = baseInput();
    input.config.channels = { inApp: true, email: false };
    input.config.recipients = { mode: 'managers', specificPeople: [] };

    // First find() call = defaulter TeamMembers batch → has reportsTo pointing to managerMemberId
    const memberDoc = {
      _id: memberObjId,
      reportsTo: managerMemberId,
      linkedUserId: null,
    };
    // Second find() call = manager TeamMembers batch → has linkedUserId (the linked User id)
    const managerDoc = {
      _id: managerMemberId,
      reportsTo: null,
      linkedUserId: managerId,
    };

    teamMemberModel.find
      .mockReturnValueOnce(makeFindChain([memberDoc]))
      .mockReturnValueOnce(makeFindChain([managerDoc]));

    const result = await svc.dispatch(input);

    expect(result.recipientCount).toBe(1);
    const call = notificationsService.createNotification.mock.calls[0] as any[];
    expect(call[1].recipientId).toBe(managerId);
  });

  // ── Test 4: both mode combines specificPeople + managers ─────────────────
  it('mode both — deduplicates recipient set across specificPeople and managers', async () => {
    const input = baseInput();
    input.config.channels = { inApp: true, email: false };
    // specificPeople contains managerId; managers mode also resolves managerId → dedup to 1
    input.config.recipients = { mode: 'both', specificPeople: [managerId] };

    const memberDoc = { _id: memberObjId, reportsTo: managerMemberId, linkedUserId: null };
    const managerDoc = { _id: managerMemberId, reportsTo: null, linkedUserId: managerId };

    teamMemberModel.find
      .mockReturnValueOnce(makeFindChain([memberDoc]))
      .mockReturnValueOnce(makeFindChain([managerDoc]));

    const result = await svc.dispatch(input);

    // managerId appears in both specificPeople and managers — deduplicated to 1
    expect(result.recipientCount).toBe(1);
  });

  // ── Test 5: empty defaulters list ─────────────────────────────────────────
  it('returns recipientCount 0 and sends nothing when defaulters list is empty', async () => {
    const input = baseInput();
    input.defaulters = [];

    const result = await svc.dispatch(input);

    expect(result.recipientCount).toBe(0);
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });

  // ── Test 6: email channel — quota allowed ────────────────────────────────
  it('sends email when quota is allowed', async () => {
    const input = baseInput();
    input.config.channels = { inApp: false, email: true };
    input.config.recipients = { mode: 'specificPeople', specificPeople: [recipientId1] };

    mailService.checkEmailQuota.mockResolvedValue({ allowed: true });
    userModel.findById.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ email: 'recipient@test.com' }),
    });

    const result = await svc.dispatch(input);

    expect(result.channelsSent.email).toBe(1);
    // After Fix 1: the send goes through the proper MailService method
    expect(mailService.sendDefaulterAlertEmail).toHaveBeenCalledTimes(1);
    const emailArgs = mailService.sendDefaulterAlertEmail.mock.calls[0][0];
    expect(emailArgs.to).toBe('recipient@test.com');
    expect(emailArgs.monthLabel).toBe('April 2026');
  });

  // ── Test 7: email channel — quota denied ─────────────────────────────────
  it('skips email when quota is denied', async () => {
    const input = baseInput();
    input.config.channels = { inApp: false, email: true };
    input.config.recipients = { mode: 'specificPeople', specificPeople: [recipientId1] };

    mailService.checkEmailQuota.mockResolvedValue({ allowed: false, reason: 'limit reached' });
    userModel.findById.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ email: 'recipient@test.com' }),
    });

    const result = await svc.dispatch(input);

    expect(result.channelsSent.email).toBe(0);
    expect(mailService.sendDefaulterAlertEmail).not.toHaveBeenCalled();
  });

  // ── Test 8: per-recipient failure isolation ────────────────────────────────
  it('increments failures and continues when one recipient notification throws', async () => {
    const input = baseInput();
    input.config.channels = { inApp: true, email: false };
    input.config.recipients = {
      mode: 'specificPeople',
      specificPeople: [recipientId1, recipientId2],
    };

    // First call throws; second succeeds
    notificationsService.createNotification
      .mockRejectedValueOnce(new Error('notification boom'))
      .mockResolvedValueOnce({});

    const result = await svc.dispatch(input);

    expect(result.failures).toBe(1);
    expect(result.channelsSent.inApp).toBe(1);
    await settle(); // let audit fire-and-forget settle
    // Audit _failed should have been called once for the failing recipient
    const failedCalls = (auditService.logEvent.mock.calls as any[][]).filter((c) =>
      (c[0].action as string).includes('_failed'),
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
  });
});
