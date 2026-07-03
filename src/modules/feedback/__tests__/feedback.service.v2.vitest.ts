/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { FeedbackService } from '../feedback.service';

// Covers the v2 feedback fields (scope, attachments, context, optional rating)
// + the PostHog write event. Constructs the service directly with mocks, like
// feedback.service.spec.ts. Links to: feedback.service.ts.
describe('FeedbackService — v2 fields', () => {
  let feedbackModel: any;
  let audit: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn> };
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
    audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn() };
    svc = new FeedbackService(feedbackModel, audit as any, postHog as any);
  });

  it('persists scope, attachments, context and optional null rating', async () => {
    await svc.create(wsId, userId, {
      module: 'attendance',
      message: 'Edit screen confusing.',
      scope: 'page',
      attachments: [
        'r2-private://erp-feedback-media/1-a.webp',
        'r2-private://erp-feedback-media/2-b.webp',
      ],
      context: { path: '/dashboard/attendance', locale: 'gu', viewport: '1440x900' },
    } as any);
    const persisted = feedbackModel.create.mock.calls[0][0];
    expect(persisted.scope).toBe('page');
    expect(persisted.attachments).toHaveLength(2);
    expect(persisted.rating).toBeNull();
    expect(persisted.context.path).toBe('/dashboard/attendance');
  });

  it('defaults scope=page and attachments=[] when omitted', async () => {
    await svc.create(wsId, userId, { module: 'team', rating: 4, message: 'ok' } as any);
    const persisted = feedbackModel.create.mock.calls[0][0];
    expect(persisted.scope).toBe('page');
    expect(persisted.attachments).toEqual([]);
  });

  it('emits feedback.feedback_submitted to PostHog', async () => {
    await svc.create(wsId, userId, {
      module: 'salary',
      rating: 5,
      message: 'love it',
      scope: 'general',
    } as any);
    expect(postHog.capture).toHaveBeenCalledTimes(1);
    expect(postHog.capture.mock.calls[0][0]).toMatchObject({
      distinctId: userId,
      event: 'feedback.feedback_submitted',
      properties: { workspaceId: wsId, module: 'salary', scope: 'general', hasRating: true },
    });
  });
});
