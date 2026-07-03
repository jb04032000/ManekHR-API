/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, PayloadTooLargeException } from '@nestjs/common';

// Stub @nestjs/mongoose decorators BEFORE importing UploadsService so the
// transitive schema decorations don't trip vitest's reflect-metadata pipeline.
// Mirrors the team / auth / quota unit suites in this codebase.
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

const MB = 1024 * 1024;

/** Build a `findOne().sort().lean().exec()` chain resolving to `value`. */
const findOneSortChain = (value: any) => ({
  sort: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
});
/** Build a `findById().select().lean().exec()` chain resolving to `value`. */
const findByIdSelectChain = (value: any) => ({
  select: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
});
/** Build a `findOne().select().lean().exec()` chain resolving to `value`. */
const findOneSelectChain = (value: any) => ({
  select: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
});

describe('UploadsService security', () => {
  let configService: any;
  let localStorageService: any;
  let r2StorageService: any;
  let workspaceModel: any;
  let workspaceMemberModel: any;
  let subscriptionModel: any;
  let uploadEventModel: any;
  let connectAllowanceService: any;
  let svc: UploadsService;

  const uploaderId = new Types.ObjectId().toHexString();
  const otherUserId = new Types.ObjectId().toHexString();
  const workspaceId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    configService = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'storage.provider') return 'local';
        if (key === 'storage.maxFileSize') return 50 * MB;
        if (key === 'storage.allowedTypes') return ['image/jpeg'];
        return undefined;
      }),
    };
    localStorageService = { deleteFile: vi.fn(), uploadFile: vi.fn() };
    r2StorageService = { deleteFile: vi.fn(), uploadFile: vi.fn() };
    workspaceModel = { findById: vi.fn(), updateOne: vi.fn() };
    workspaceMemberModel = { findOne: vi.fn() };
    subscriptionModel = { findOne: vi.fn() };
    uploadEventModel = {
      findOne: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue(undefined),
      aggregate: vi.fn(),
    };
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
  });

  // ── B. Ownership-checked delete ───────────────────────────────────────

  describe('deleteFileForUser', () => {
    it('lets the recorded uploader delete their own file', async () => {
      uploadEventModel.findOne.mockReturnValue(
        findOneSortChain({
          uploaderUserId: new Types.ObjectId(uploaderId),
          workspaceId: null,
          fileSizeBytes: 1000,
          deletedAt: null,
        }),
      );
      const markSpy = vi.spyOn(svc as any, 'markUploadEventDeleted').mockResolvedValue(undefined);

      await svc.deleteFileForUser('https://cdn/own.jpg', uploaderId, false);

      expect(localStorageService.deleteFile).toHaveBeenCalledWith('https://cdn/own.jpg');
      expect(markSpy).toHaveBeenCalledWith('https://cdn/own.jpg');
    });

    it('rejects a non-owner, non-admin with 403 and does NOT touch storage', async () => {
      uploadEventModel.findOne.mockReturnValue(
        findOneSortChain({
          uploaderUserId: new Types.ObjectId(uploaderId),
          workspaceId: null,
          fileSizeBytes: 1000,
          deletedAt: null,
        }),
      );

      await expect(
        svc.deleteFileForUser('https://cdn/own.jpg', otherUserId, false),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(localStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it('lets a platform admin delete another user file', async () => {
      uploadEventModel.findOne.mockReturnValue(
        findOneSortChain({
          uploaderUserId: new Types.ObjectId(uploaderId),
          workspaceId: null,
          fileSizeBytes: 1000,
          deletedAt: null,
        }),
      );
      vi.spyOn(svc as any, 'markUploadEventDeleted').mockResolvedValue(undefined);

      await svc.deleteFileForUser('https://cdn/own.jpg', otherUserId, true);

      expect(localStorageService.deleteFile).toHaveBeenCalledWith('https://cdn/own.jpg');
    });

    it('refunds the RECORDED size to the RECORDED workspace (client value irrelevant)', async () => {
      uploadEventModel.findOne.mockReturnValue(
        findOneSortChain({
          uploaderUserId: new Types.ObjectId(uploaderId),
          workspaceId: new Types.ObjectId(workspaceId),
          fileSizeBytes: 4096,
          deletedAt: null,
        }),
      );
      const decrementSpy = vi.spyOn(svc, 'decrementStorageUsage').mockResolvedValue(undefined);
      vi.spyOn(svc as any, 'markUploadEventDeleted').mockResolvedValue(undefined);

      // The controller never forwards a client fileSizeBytes to the service;
      // the refund is derived purely from the record (4096), not any body.
      await svc.deleteFileForUser('https://cdn/ws.jpg', uploaderId, false);

      expect(decrementSpy).toHaveBeenCalledTimes(1);
      const [wsArg, bytesArg] = decrementSpy.mock.calls[0];
      expect(String(wsArg)).toBe(workspaceId);
      expect(bytesArg).toBe(4096);
    });

    it('does not refund when the record is already soft-deleted (no double-refund)', async () => {
      uploadEventModel.findOne.mockReturnValue(
        findOneSortChain({
          uploaderUserId: new Types.ObjectId(uploaderId),
          workspaceId: new Types.ObjectId(workspaceId),
          fileSizeBytes: 4096,
          deletedAt: new Date('2026-06-10T00:00:00Z'),
        }),
      );
      const decrementSpy = vi.spyOn(svc, 'decrementStorageUsage').mockResolvedValue(undefined);

      await svc.deleteFileForUser('https://cdn/ws.jpg', uploaderId, false);

      expect(decrementSpy).not.toHaveBeenCalled();
    });

    it('treats a legacy file with no record as admin-only (403 for regular user)', async () => {
      uploadEventModel.findOne.mockReturnValue(findOneSortChain(null));

      await expect(
        svc.deleteFileForUser('https://cdn/legacy.jpg', uploaderId, false),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(localStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it('lets an admin delete a legacy file with no record', async () => {
      uploadEventModel.findOne.mockReturnValue(findOneSortChain(null));

      await svc.deleteFileForUser('https://cdn/legacy.jpg', uploaderId, true);

      expect(localStorageService.deleteFile).toHaveBeenCalledWith('https://cdn/legacy.jpg');
    });
  });

  // ── C. Server-side workspace attribution ──────────────────────────────

  describe('uploadSingle workspace attribution', () => {
    const file = { size: 1234, mimetype: 'image/jpeg' };

    it('rejects with 403 when the uploader is not a member of the workspace', async () => {
      // Not the owner...
      workspaceModel.findById.mockReturnValue(
        findByIdSelectChain({ ownerId: new Types.ObjectId(otherUserId) }),
      );
      // ...and no active membership row.
      workspaceMemberModel.findOne.mockReturnValue(findOneSelectChain(null));

      await expect(
        svc.uploadSingle(file, 'proofs', uploaderId, workspaceId),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Never reached storage / quota charge.
      expect(localStorageService.uploadFile).not.toHaveBeenCalled();
    });

    it('allows the workspace owner and writes an ownership record', async () => {
      workspaceModel.findById.mockReturnValue(
        findByIdSelectChain({ ownerId: new Types.ObjectId(uploaderId) }),
      );
      vi.spyOn(svc, 'enforceStorageQuota').mockResolvedValue(undefined);
      vi.spyOn(svc, 'incrementStorageUsage').mockResolvedValue(undefined);
      localStorageService.uploadFile.mockResolvedValue({
        url: 'https://cdn/p.jpg',
        fileName: 'p.jpg',
        fileSize: 1234,
        mimeType: 'image/jpeg',
      });

      await svc.uploadSingle(file, 'proofs', uploaderId, workspaceId);

      expect(uploadEventModel.create).toHaveBeenCalledTimes(1);
      const arg = uploadEventModel.create.mock.calls[0][0];
      expect(String(arg.uploaderUserId)).toBe(uploaderId);
      expect(String(arg.workspaceId)).toBe(workspaceId);
    });
  });

  // ── A. Ownership record on the legacy (avatar) path ───────────────────

  describe('uploadSingle ownership record', () => {
    it('writes an ownership record with null workspace on the avatar path', async () => {
      const file = { size: 500, mimetype: 'image/jpeg' };
      localStorageService.uploadFile.mockResolvedValue({
        url: 'https://cdn/a.jpg',
        fileName: 'a.jpg',
        fileSize: 500,
        mimeType: 'image/jpeg',
      });

      await svc.uploadSingle(file, 'avatars', uploaderId);

      expect(uploadEventModel.create).toHaveBeenCalledTimes(1);
      const arg = uploadEventModel.create.mock.calls[0][0];
      expect(String(arg.uploaderUserId)).toBe(uploaderId);
      expect(arg.workspaceId).toBeNull();
      // Avatar path must not charge any workspace counter.
      expect(workspaceModel.updateOne).not.toHaveBeenCalled();
    });
  });

  // ── D. Per-user Connect storage quota ─────────────────────────────────

  describe('enforceConnectStorageQuota', () => {
    it('allows an upload that stays under the per-user cap', async () => {
      connectAllowanceService.getAllowances.mockResolvedValue({ storageMb: 500 });
      uploadEventModel.aggregate.mockResolvedValue([{ total: 100 * MB }]);

      await expect(svc.enforceConnectStorageQuota(uploaderId, 10 * MB)).resolves.toBeUndefined();
    });

    it('rejects with 413 when the upload would exceed the 500 MB cap', async () => {
      connectAllowanceService.getAllowances.mockResolvedValue({ storageMb: 500 });
      uploadEventModel.aggregate.mockResolvedValue([{ total: 499 * MB }]);

      await expect(svc.enforceConnectStorageQuota(uploaderId, 5 * MB)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });

    it('respects -1 as unlimited and never queries usage', async () => {
      connectAllowanceService.getAllowances.mockResolvedValue({ storageMb: -1 });

      await expect(svc.enforceConnectStorageQuota(uploaderId, 9999 * MB)).resolves.toBeUndefined();
      expect(uploadEventModel.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('uploadSingle connect path', () => {
    it('enforces the per-user connect cap and writes an ownership record', async () => {
      const file = { size: 1 * MB, mimetype: 'image/jpeg' };
      const connectSpy = vi.spyOn(svc, 'enforceConnectStorageQuota').mockResolvedValue(undefined);
      localStorageService.uploadFile.mockResolvedValue({
        url: 'https://cdn/post.jpg',
        fileName: 'post.jpg',
        fileSize: 1 * MB,
        mimeType: 'image/jpeg',
      });

      await svc.uploadSingle(file, 'connect-posts', uploaderId);

      expect(connectSpy).toHaveBeenCalledWith(uploaderId, 1 * MB);
      expect(uploadEventModel.create).toHaveBeenCalledTimes(1);
      const arg = uploadEventModel.create.mock.calls[0][0];
      expect(arg.workspaceId).toBeNull();
      expect(arg.category).toBe('connect-posts');
    });
  });
});
