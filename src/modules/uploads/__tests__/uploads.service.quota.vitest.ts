/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing UploadsService so the
// transitive schema decorations don't trip vitest's reflect-metadata pipeline.
// Mirrors the team / auth unit suites in this codebase.
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
import { UploadsService } from '../uploads.service';

const workspaceId = new Types.ObjectId().toHexString();

describe('UploadsService.releaseFileFromQuota', () => {
  let configService: any;
  let localStorageService: any;
  let r2StorageService: any;
  let workspaceModel: any;
  let workspaceMemberModel: any;
  let subscriptionModel: any;
  let uploadEventModel: any;
  let connectAllowanceService: any;
  let storageService: any;
  let svc: UploadsService;
  let decrementSpy: any;
  let markDeletedSpy: any;

  beforeEach(() => {
    // configService.get returns a value per key; provider selects local vs r2.
    configService = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'storage.provider') return 'local';
        if (key === 'storage.maxFileSize') return 10 * 1024 * 1024;
        if (key === 'storage.allowedTypes') return ['image/jpeg'];
        return undefined;
      }),
    };
    // Stub both storage services with deleteFile so whichever the constructor
    // wires up, the spy target exists.
    localStorageService = { deleteFile: vi.fn() };
    r2StorageService = { deleteFile: vi.fn() };
    workspaceModel = {};
    subscriptionModel = {};
    uploadEventModel = { findOne: vi.fn() };
    workspaceMemberModel = {};
    connectAllowanceService = { getAllowances: vi.fn() };

    svc = new UploadsService(
      configService,
      localStorageService,
      r2StorageService,
      workspaceModel,
      workspaceMemberModel,
      subscriptionModel,
      uploadEventModel,
      connectAllowanceService,
    );

    // local provider selected above -> storageService is the local stub.
    storageService = localStorageService;

    decrementSpy = vi.spyOn(svc, 'decrementStorageUsage').mockResolvedValue(undefined);
    markDeletedSpy = vi.spyOn(svc as any, 'markUploadEventDeleted').mockResolvedValue(undefined);
  });

  it('releaseFileFromQuota refunds the recorded size and keeps the physical file', async () => {
    uploadEventModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ fileSizeBytes: 2048 }) }),
    });

    await svc.releaseFileFromQuota('https://cdn/x.jpg', workspaceId);

    expect(storageService.deleteFile).not.toHaveBeenCalled();
    expect(decrementSpy).toHaveBeenCalledWith(workspaceId, 2048);
    expect(markDeletedSpy).toHaveBeenCalledWith('https://cdn/x.jpg');
    // Only live events are acted on, so a re-release can never double-refund.
    expect(uploadEventModel.findOne).toHaveBeenCalledWith({
      fileUrl: 'https://cdn/x.jpg',
      deletedAt: null,
    });
  });

  it('releaseFileFromQuota is a no-op for an unknown file', async () => {
    uploadEventModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    });

    await svc.releaseFileFromQuota('https://cdn/missing.jpg', workspaceId);

    expect(decrementSpy).not.toHaveBeenCalled();
    expect(storageService.deleteFile).not.toHaveBeenCalled();
    expect(markDeletedSpy).not.toHaveBeenCalled();
  });

  it('releaseFileFromQuota does not double-refund an already-released file', async () => {
    // An already-released event has deletedAt set, so the `deletedAt: null`
    // lookup returns null and the method is a true no-op.
    uploadEventModel.findOne.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    });

    await svc.releaseFileFromQuota('https://cdn/already.jpg', workspaceId);

    expect(decrementSpy).not.toHaveBeenCalled();
    expect(markDeletedSpy).not.toHaveBeenCalled();
  });
});
