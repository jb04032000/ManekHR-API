/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { FeedbackService } from '../feedback.service';

describe('FeedbackService', () => {
  let feedbackModel: any;
  let audit: { logEvent: ReturnType<typeof vi.fn> };
  let svc: FeedbackService;

  const wsId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    feedbackModel = {
      create: vi.fn().mockImplementation((doc: any) =>
        Promise.resolve({
          _id: new Types.ObjectId(),
          ...doc,
        }),
      ),
    };
    audit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };
    const postHog = { capture: vi.fn() };
    svc = new FeedbackService(feedbackModel, audit as any, postHog as any);
  });

  it('persists feedback with default category and fires audit log', async () => {
    const result = await svc.create(wsId, userId, {
      module: 'team',
      rating: 4,
      message: 'Solid v1, missing bulk import.',
    });

    expect(feedbackModel.create).toHaveBeenCalledTimes(1);
    const persisted = feedbackModel.create.mock.calls[0][0];
    expect(persisted.module).toBe('team');
    expect(persisted.rating).toBe(4);
    expect(persisted.category).toBe('general');
    expect(persisted.workspaceId.toString()).toBe(wsId);
    expect(persisted.userId.toString()).toBe(userId);

    // Audit fires fire-and-forget — give the queued microtask a tick.
    await Promise.resolve();
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const call = audit.logEvent.mock.calls[0][0];
    expect(call.module).toBe('feedback');
    expect(call.entityType).toBe('feedback');
    expect(call.action).toBe('create');
    expect(call.actorId).toBe(userId);
    expect(call.meta).toMatchObject({ module: 'team', rating: 4 });

    expect(result).toBeDefined();
  });

  it('honours an explicit category', async () => {
    await svc.create(wsId, userId, {
      module: 'attendance',
      rating: 2,
      message: 'Edit screen confusing.',
      category: 'bug_report',
    });

    expect(feedbackModel.create.mock.calls[0][0].category).toBe('bug_report');
  });

  it('swallows audit failures without rejecting the create promise', async () => {
    audit.logEvent.mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      svc.create(wsId, userId, {
        module: 'salary',
        rating: 5,
        message: 'Loving the new layout',
      }),
    ).resolves.toBeDefined();
    // Allow the rejected fire-and-forget to settle so the spy records it.
    await new Promise((r) => setImmediate(r));
    expect(audit.logEvent).toHaveBeenCalled();
  });
});
