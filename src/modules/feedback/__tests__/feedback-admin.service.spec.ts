/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { FeedbackAdminService } from '../feedback-admin.service';

describe('FeedbackAdminService', () => {
  let feedbackModel: any;
  let audit: { logEvent: ReturnType<typeof vi.fn> };
  let svc: FeedbackAdminService;

  const fakeId = new Types.ObjectId().toHexString();
  const wsId = new Types.ObjectId();

  function chainExec<T>(value: T) {
    return {
      sort: () => chainExec(value),
      skip: () => chainExec(value),
      limit: () => chainExec(value),
      lean: () => chainExec(value),
      exec: () => Promise.resolve(value),
    };
  }

  beforeEach(() => {
    feedbackModel = {
      find: vi.fn(),
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
    };
    audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const privateMedia = {
      signMany: vi.fn().mockResolvedValue(new Map()),
      resolve: vi.fn((r: unknown) => r),
    };
    svc = new FeedbackAdminService(feedbackModel, audit as any, privateMedia as any);
  });

  describe('list', () => {
    it('paginates with default page=1 limit=20 and excludes deleted by default', async () => {
      const items = [{ _id: new Types.ObjectId(), message: 'one' }];
      feedbackModel.find.mockReturnValue(chainExec(items));
      feedbackModel.countDocuments.mockReturnValue({
        exec: () => Promise.resolve(items.length),
      });

      const out = await svc.list({});

      expect(feedbackModel.find).toHaveBeenCalledTimes(1);
      const filter = feedbackModel.find.mock.calls[0][0];
      expect(filter.isDeleted).toEqual({ $ne: true });
      expect(out.page).toBe(1);
      expect(out.limit).toBe(20);
      expect(out.total).toBe(1);
      expect(out.pages).toBe(1);
    });

    it('builds case-insensitive search across message + module + category', async () => {
      feedbackModel.find.mockReturnValue(chainExec([]));
      feedbackModel.countDocuments.mockReturnValue({
        exec: () => Promise.resolve(0),
      });

      await svc.list({ search: 'CRASH', page: 2, limit: 5 });

      const filter = feedbackModel.find.mock.calls[0][0];
      expect(Array.isArray(filter.$or)).toBe(true);
      expect(filter.$or.length).toBe(3);
      const rx = filter.$or[0].message as RegExp;
      expect(rx.flags).toContain('i');
      expect(rx.test('crash report')).toBe(true);
    });

    it('honours includeDeleted=true', async () => {
      feedbackModel.find.mockReturnValue(chainExec([]));
      feedbackModel.countDocuments.mockReturnValue({
        exec: () => Promise.resolve(0),
      });

      await svc.list({ includeDeleted: true });

      const filter = feedbackModel.find.mock.calls[0][0];
      expect(filter.isDeleted).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('throws NotFound for invalid ObjectId', async () => {
      await expect(
        svc.updateStatus('not-a-mongo-id', { status: 'reviewed' }, 'actor'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when feedback missing', async () => {
      feedbackModel.findById.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      });

      await expect(
        svc.updateStatus(fakeId, { status: 'reviewed' }, 'actor'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates status and emits audit log with before/after diff', async () => {
      const before = {
        _id: new Types.ObjectId(fakeId),
        workspaceId: wsId,
        status: 'new',
        adminNotes: null,
      };
      const after = { ...before, status: 'reviewed', adminNotes: 'looking' };

      feedbackModel.findById.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(before) }),
      });
      feedbackModel.findByIdAndUpdate.mockReturnValue({
        exec: () => Promise.resolve(after),
      });

      const out = await svc.updateStatus(
        fakeId,
        { status: 'reviewed', adminNotes: 'looking' },
        'actor-1',
      );

      expect(out).toBe(after);
      const setOp = feedbackModel.findByIdAndUpdate.mock.calls[0][1].$set;
      expect(setOp.status).toBe('reviewed');
      expect(setOp.adminNotes).toBe('looking');

      await Promise.resolve();
      expect(audit.logEvent).toHaveBeenCalledTimes(1);
      const auditCall = audit.logEvent.mock.calls[0][0];
      expect(auditCall.action).toBe('update_status');
      expect(auditCall.before).toEqual({ status: 'new', adminNotes: null });
      expect(auditCall.after).toEqual({ status: 'reviewed', adminNotes: 'looking' });
    });

    it('skips adminNotes set when caller omits it', async () => {
      const before = {
        _id: new Types.ObjectId(fakeId),
        workspaceId: wsId,
        status: 'new',
        adminNotes: 'kept',
      };
      const after = { ...before, status: 'in_progress' };

      feedbackModel.findById.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(before) }),
      });
      feedbackModel.findByIdAndUpdate.mockReturnValue({
        exec: () => Promise.resolve(after),
      });

      await svc.updateStatus(fakeId, { status: 'in_progress' }, 'actor-2');

      const setOp = feedbackModel.findByIdAndUpdate.mock.calls[0][1].$set;
      expect(setOp).not.toHaveProperty('adminNotes');
    });
  });
});
