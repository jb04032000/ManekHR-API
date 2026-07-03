/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing StorefrontService so the
// transitive schema imports (Storefront, CompanyPage with their own @Prop
// decorations) don't trip the "Cannot determine type" reflection error under
// vitest's esbuild transform. Models are injected as plain mocks below.
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
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { StorefrontService } from '../services/storefront.service';

/**
 * Unit coverage for the company-page <-> storefront link methods on
 * StorefrontService (attach / unlink / get). Mocks storefrontModel +
 * companyPageModel; the other deps (allowances, erpLink, audit, posthog) are
 * stubs since the link paths only touch the two models + audit.
 */
describe('StorefrontService link', () => {
  const userId = new Types.ObjectId().toHexString();
  const pageId = new Types.ObjectId().toHexString();
  const storeId = new Types.ObjectId().toHexString();
  let svc: any;
  let storefrontModel: any;
  let companyPageModel: any;
  let audit: { logEvent: ReturnType<typeof vi.fn> };

  // Build the real service with mocked models. Constructor order matches
  // StorefrontService: (model, companyPageModel, allowances, erpLink, audit, posthog?).
  const makeService = () => {
    const allowances = {} as any;
    const erpLink = {} as any;
    return new StorefrontService(
      storefrontModel,
      companyPageModel,
      allowances,
      erpLink,
      audit as any,
    );
  };

  beforeEach(() => {
    companyPageModel = { findOne: vi.fn() };
    storefrontModel = { findOne: vi.fn(), updateMany: vi.fn(), updateOne: vi.fn() };
    audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    svc = makeService();
  });

  it('attach rejects when caller does not own the page', async () => {
    companyPageModel.findOne.mockResolvedValue(null); // not owned
    await expect(svc.attachStorefrontToPage(userId, pageId, storeId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('attach rejects a store already linked to a different page', async () => {
    companyPageModel.findOne.mockResolvedValue({ _id: pageId, ownerUserId: userId });
    storefrontModel.findOne.mockResolvedValue({
      _id: storeId,
      ownerUserId: userId,
      companyPageId: new Types.ObjectId(), // already linked elsewhere
    });
    await expect(svc.attachStorefrontToPage(userId, pageId, storeId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('attach clears any prior store on the page then links the new one', async () => {
    companyPageModel.findOne.mockResolvedValue({ _id: pageId, ownerUserId: userId });
    storefrontModel.findOne.mockResolvedValue({
      _id: storeId,
      ownerUserId: userId,
      companyPageId: null,
    });
    storefrontModel.updateMany.mockResolvedValue({});
    storefrontModel.updateOne.mockResolvedValue({});
    await svc.attachStorefrontToPage(userId, pageId, storeId);
    expect(storefrontModel.updateMany).toHaveBeenCalledWith(
      { companyPageId: expect.anything(), _id: { $ne: expect.anything() } },
      { $set: { companyPageId: null } },
    );
    expect(storefrontModel.updateOne).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storefront_linked_page' }),
    );
  });

  it('unlink tolerates a page with no attached store', async () => {
    companyPageModel.findOne.mockResolvedValue({ _id: pageId, ownerUserId: userId });
    storefrontModel.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(svc.unlinkStorefrontFromPage(userId, pageId)).resolves.toEqual({ linked: false });
    expect(audit.logEvent).not.toHaveBeenCalled();
  });
});
