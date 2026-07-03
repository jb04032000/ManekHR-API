/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the transitive
// schema import doesn't trip "Cannot determine type" under vitest's transform.
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
import { NotFoundException } from '@nestjs/common';
import { ContentReportsService } from '../content-reports.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { CONTENT_TAKEDOWN_EVENT } from '../content-reports.constants';

function chain<T>(result: T) {
  const c: any = {};
  c.sort = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.lean = vi.fn(() => c);
  c.select = vi.fn(() => c);
  c.exec = vi.fn(() => Promise.resolve(result));
  return c;
}

describe('ContentReportsService', () => {
  const reporterId = new Types.ObjectId().toString();
  const adminId = new Types.ObjectId().toString();
  const reportId = new Types.ObjectId();

  const openReport = {
    _id: reportId,
    reporterUserId: new Types.ObjectId(reporterId),
    targetType: 'post',
    targetId: 'post123',
    reason: 'spam',
    status: 'open',
  };

  let model: any;
  let audit: { logEvent: ReturnType<typeof vi.fn> };
  let events: { emit: ReturnType<typeof vi.fn> };
  let posthog: { capture: ReturnType<typeof vi.fn> };
  let svc: ContentReportsService;

  beforeEach(() => {
    model = {
      findOne: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([openReport])),
      countDocuments: vi.fn(() => chain(3)),
      findByIdAndUpdate: vi.fn(() => chain({ ...openReport, status: 'actioned' })),
      create: vi.fn().mockResolvedValue(openReport),
    };
    audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    events = { emit: vi.fn() };
    posthog = { capture: vi.fn() };
    svc = new ContentReportsService(model, audit as any, events as any, posthog as any);
  });

  const settle = () => new Promise((r) => setImmediate(r));

  // ── create: dedup + persist ────────────────────────────────────────────────
  it('create returns the existing OPEN report instead of stacking a duplicate', async () => {
    model.findOne = vi.fn(() => chain(openReport)); // already an open report

    const result = await svc.create(reporterId, {
      targetType: 'post',
      targetId: 'post123',
      reason: 'spam',
    } as any);

    expect(model.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ targetId: 'post123', status: 'open' });
  });

  it('create persists a new report and emits a PostHog event', async () => {
    model.findOne = vi.fn(() => chain(null)); // no prior open report

    await svc.create(reporterId, {
      targetType: 'listing',
      targetId: 'lst9',
      reason: 'scam',
      detail: 'fake',
    } as any);

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'listing', targetId: 'lst9', reason: 'scam' }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.content_reported' }),
    );
  });

  // ── admin: action removes + emits takedown ─────────────────────────────────
  it('action marks the report actioned, audits it, and emits the takedown event', async () => {
    const result = await svc.action(reportId.toString(), adminId, 'removed');
    await settle();

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      reportId.toString(),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'actioned' }) }),
      { returnDocument: 'after' },
    );
    expect(events.emit).toHaveBeenCalledWith(
      CONTENT_TAKEDOWN_EVENT,
      expect.objectContaining({ targetType: 'post', targetId: 'post123', actorId: adminId }),
    );
    expect(audit.logEvent.mock.calls[0][0]).toMatchObject({
      module: AppModule.CONNECT,
      entityType: 'ContentReport',
      action: 'content_report_actioned',
      actorId: adminId,
    });
    expect(result).toMatchObject({ status: 'actioned' });
  });

  it('dismiss marks the report dismissed and does NOT emit a takedown', async () => {
    model.findByIdAndUpdate = vi.fn(() => chain({ ...openReport, status: 'dismissed' }));

    await svc.dismiss(reportId.toString(), adminId, 'not a violation');
    await settle();

    expect(events.emit).not.toHaveBeenCalled();
    expect(audit.logEvent.mock.calls[0][0]).toMatchObject({
      action: 'content_report_dismissed',
    });
  });

  it('action throws NotFound when the report is missing', async () => {
    model.findByIdAndUpdate = vi.fn(() => chain(null));

    await expect(svc.action(reportId.toString(), adminId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── admin queue reads ──────────────────────────────────────────────────────
  it('listOpen filters to open reports newest-first', async () => {
    await svc.listOpen();
    expect(model.find).toHaveBeenCalledWith({ status: 'open' });
  });

  it('countOpen counts open reports', async () => {
    const n = await svc.countOpen();
    expect(model.countDocuments).toHaveBeenCalledWith({ status: 'open' });
    expect(n).toBe(3);
  });
});
