/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing LegalPagesService so the
// transitive schema import (LegalPage) doesn't trip the "Cannot determine type"
// reflection error under vitest's esbuild transform. The Model is injected as a
// plain mock — we never touch real Mongoose here.
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
import { ConflictException, NotFoundException } from '@nestjs/common';
import { LegalPagesService } from '../legal-pages.service';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Build a Mongoose query-chain mock that resolves to `result` no matter which
 * of .sort()/.lean()/.select()/.exec() the service threads together.
 */
function chain<T>(result: T) {
  const c: any = {};
  c.sort = vi.fn(() => c);
  c.lean = vi.fn(() => c);
  c.select = vi.fn(() => c);
  c.exec = vi.fn(() => Promise.resolve(result));
  return c;
}

describe('LegalPagesService', () => {
  const actorId = new Types.ObjectId().toString();
  const pageId = new Types.ObjectId();

  const draftPage = {
    _id: pageId,
    slug: 'terms-connect',
    product: 'connect',
    kind: 'terms',
    title: 'Connect Terms',
    body: '# draft',
    status: 'draft',
    version: 1,
  };
  const publishedPage = { ...draftPage, status: 'published', version: 2 };

  let model: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let svc: LegalPagesService;

  beforeEach(() => {
    model = {
      find: vi.fn(() => chain([draftPage])),
      findById: vi.fn(() => chain(draftPage)),
      findOne: vi.fn(() => chain(null)),
      findByIdAndUpdate: vi.fn(() => chain(publishedPage)),
      findByIdAndDelete: vi.fn(() => chain(draftPage)),
      create: vi.fn().mockResolvedValue(draftPage),
    };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    svc = new LegalPagesService(model, auditService as any);
  });

  const settle = () => new Promise((r) => setImmediate(r));

  // ── public read: published-only ───────────────────────────────────────────
  it('getPublishedBySlug returns the page when one is published', async () => {
    model.findOne = vi.fn(() => chain(publishedPage));

    const result = await svc.getPublishedBySlug('terms-connect');

    expect(model.findOne).toHaveBeenCalledWith({ slug: 'terms-connect', status: 'published' });
    expect(result).toMatchObject({ slug: 'terms-connect', status: 'published' });
  });

  it('getPublishedBySlug throws NotFound when the slug has no published version (draft is hidden)', async () => {
    model.findOne = vi.fn(() => chain(null)); // a draft-only slug resolves to null under the published filter

    await expect(svc.getPublishedBySlug('terms-connect')).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── publish: flips status + bumps version ─────────────────────────────────
  it('publish flips status to published and bumps version', async () => {
    const result = await svc.publish(pageId.toString(), actorId);

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      pageId.toString(),
      { $set: { status: 'published' }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    expect(result).toMatchObject({ status: 'published', version: 2 });
  });

  it('publish throws NotFound when the page does not exist', async () => {
    model.findByIdAndUpdate = vi.fn(() => chain(null));

    await expect(svc.publish(pageId.toString(), actorId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publish writes an audit event under the LEGAL module', async () => {
    await svc.publish(pageId.toString(), actorId);
    await settle();

    expect(auditService.logEvent).toHaveBeenCalled();
    expect(auditService.logEvent.mock.calls[0][0]).toMatchObject({
      module: AppModule.LEGAL,
      entityType: 'legal_page',
      action: 'legal_page_published',
      actorId,
    });
  });

  // ── create: slug uniqueness + audit ───────────────────────────────────────
  it('create rejects a duplicate slug with Conflict', async () => {
    model.findOne = vi.fn(() => chain(draftPage)); // slug already taken

    await expect(
      svc.create(
        { slug: 'terms-connect', product: 'connect', kind: 'terms', title: 'x', body: 'y' } as any,
        actorId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('create persists a new page and audits it', async () => {
    model.findOne = vi.fn(() => chain(null)); // slug free

    const result = await svc.create(
      { slug: 'privacy-erp', product: 'erp', kind: 'privacy', title: 'x', body: 'y' } as any,
      actorId,
    );
    await settle();

    expect(model.create).toHaveBeenCalled();
    expect(result).toMatchObject({ slug: 'terms-connect' }); // mock create return
    expect(auditService.logEvent.mock.calls[0][0]).toMatchObject({
      module: AppModule.LEGAL,
      action: 'legal_page_created',
    });
  });

  it('create persists a Community Guidelines page (guidelines kind)', async () => {
    model.findOne = vi.fn(() => chain(null)); // slug free

    await svc.create(
      {
        slug: 'guidelines-connect',
        product: 'connect',
        kind: 'guidelines',
        title: 'Connect Community Guidelines',
        body: '# rules',
      } as any,
      actorId,
    );
    await settle();

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'guidelines-connect', kind: 'guidelines' }),
    );
    expect(auditService.logEvent.mock.calls[0][0]).toMatchObject({
      module: AppModule.LEGAL,
      action: 'legal_page_created',
    });
  });

  // ── delete: NotFound guard ────────────────────────────────────────────────
  it('remove throws NotFound when the page is missing', async () => {
    model.findByIdAndDelete = vi.fn(() => chain(null));

    await expect(svc.remove(pageId.toString(), actorId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
