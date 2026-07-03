import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  ForbiddenException,
  PayloadTooLargeException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IStorageService } from './services/storage.interface';
import { LocalStorageService } from './services/local-storage.service';
import { R2StorageService } from './services/r2-storage.service';
import { UploadResponseDto } from './dto/upload-response.dto';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { UploadEvent } from './schemas/upload-event.schema';
import {
  UPLOAD_CATEGORIES,
  checkUploadPolicy,
  isPrivateCategory,
  resolveUploadPolicy,
  type UploadCategory,
} from './upload-policies';
import { sniffAndCheck } from './content-sniffer';
import { probeAndCheckAudio, probeAndCheckImage, probeAndCheckVideo } from './media-probe';

const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Last path segment of a file URL / `r2-private://` ref, for log context that
 * identifies the object WITHOUT leaking the full URL or any PII (workspace /
 * user ids never appear in storage keys, which are `category/<ts>-<rand>.<ext>`).
 */
function fileKeyHint(fileUrl: string): string {
  return fileUrl.split('/').pop() || fileUrl.slice(-32);
}

/** Concise error message for a swallowed-but-logged catch (no stack, no PII). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StorageQuotaResult {
  allowed: boolean;
  reason?: string;
  /** GB cap; -1 = unlimited */
  totalGbPerWorkspace: number;
  /** MB cap on individual file */
  perFileMaxMb: number;
  /** Bytes currently consumed */
  currentBytes: number;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly storageService: IStorageService;
  private readonly maxFileSize: number;
  private readonly allowedTypes: string[];

  constructor(
    private configService: ConfigService,
    private localStorageService: LocalStorageService,
    private r2StorageService: R2StorageService,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private workspaceMemberModel: Model<WorkspaceMember>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(UploadEvent.name)
    private uploadEventModel: Model<UploadEvent>,
  ) {
    const provider = this.configService.get<string>('storage.provider');
    this.storageService = provider === 'r2' ? this.r2StorageService : this.localStorageService;

    this.maxFileSize = this.configService.get<number>('storage.maxFileSize');
    this.allowedTypes = this.configService.get<string[]>('storage.allowedTypes');
  }

  /**
   * Upload a single file, enforce storage quotas, and persist an ownership
   * record for it.
   *
   * `uploaderUserId` is the authenticated user (`req.user.sub`), plumbed from
   * the controller. It is the source of truth for the ownership-checked
   * delete — never trusted from the client body.
   *
   * Quota attribution is server-derived:
   *  - Workspace path (`workspaceId` supplied): the caller MUST be a member of
   *    that workspace (owner or active member), else 403 — this stops a client
   *    from charging an arbitrary workspace's quota. The workspace tier cap is
   *    then enforced + charged.
     * The avatar / identity (legacy) path passes no workspaceId, so it skips the
   * quota gate but STILL gets an ownership record.
   */
  async uploadSingle(
    file: any,
    category: string,
    uploaderUserId: string | Types.ObjectId,
    workspaceId?: string | Types.ObjectId,
  ): Promise<UploadResponseDto> {
    this.validateCategory(category);


    if (workspaceId) {
      // Server-side attribution: only a member may charge a workspace's quota.
      await this.assertWorkspaceMembership(uploaderUserId, workspaceId);
      await this.enforceStorageQuota(workspaceId, file?.size || 0, file?.mimetype);
    }


    this.validateFileWithCategory(file, category);
    // Magic-byte content sniff — runs AFTER the cheap declared-mime/size guard
    // and BEFORE storage, so spoofed content never reaches disk/R2.
    await this.validateFileContent(file, category);
    // Media constraints (audio duration + image dimensions) — runs alongside
    // the sniffer, still before storage. Returns the server-parsed audio
    // duration so it can be persisted as the source of truth (the client's
    // claimed duration is never trusted).
    const { audioDurationSec, videoDurationSec } = await this.validateMediaConstraints(
      file,
      category,
    );

    // Private categories (chat media, job-application files) land on the private
    // bucket and come back as a canonical `r2-private://` ref - never a public
    // URL. Everything downstream (ownership record, delete, read-path signing)
    // keys off that ref. Public categories are unchanged.
    const visibility = isPrivateCategory(category) ? 'private' : 'public';

    let result: UploadResponseDto;
    try {
      result = await this.storageService.uploadFile(file, category, visibility);
    } catch (error) {
      this.logger.error(`Upload failed: ${error?.message ?? error}`);
      throw new InternalServerErrorException('File upload failed');
    }

    // Charge the workspace counter only on the workspace path.
    if (workspaceId) {
      await this.incrementStorageUsage(workspaceId, file?.size || 0);
    }

    // Ownership record on EVERY successful upload (both paths). Source of truth
    // for ownership-checked delete, Connect per-user usage, and the workspace
    // recompute. Best-effort; never blocks the upload response.
    await this.logUploadEvent(
      uploaderUserId,
      workspaceId ?? null,
      result,
      category,
      file?.mimetype,
      audioDurationSec,
      videoDurationSec,
    );

    return result;
  }

  /**
   * Ownership-checked delete for the user-facing `DELETE /uploads/file`
   * endpoint. Distinct from `deleteFile` below, which is the trusted
   * server-side cascade-delete path (team / bills / documents) with no
   * caller to authorize.
   *
   * Authorization (looked up by url against the ownership record):
   *  - Record found with a recorded uploader: only that uploader, or a
   *    platform admin, may delete. Anyone else gets 403.
   *  - No record (legacy files uploaded before ownership tracking) or a
   *    record without an uploader (workspace-path rows predating
   *    `uploaderUserId`): platform admin only; regular users get 403.
   * Authorization errors ALWAYS propagate — they are decided before the
   * delete and are never swallowed by the "already deleted" tolerance.
   *
   * Quota refund is derived from the RECORD (`workspaceId`, `fileSizeBytes`),
   * never from the client body. The controller still accepts the legacy
   * `workspaceId` / `fileSizeBytes` body fields for FE backward-compat, but
   * this service ignores them. Connect (per-user) usage is computed live from
   * records, so marking the record deleted is what frees a person's Connect
   * quota.
   */
  async deleteFileForUser(
    fileUrl: string,
    requesterUserId: string | Types.ObjectId,
    isAdmin: boolean,
  ): Promise<void> {
    // Most recent record for this url, regardless of soft-delete state, so the
    // ownership decision is stable even if the row was already marked deleted.
    const record = await this.uploadEventModel
      .findOne({ fileUrl })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    // ── Authorization (must propagate; not wrapped in the tolerance catch) ──
    const recordedUploader = (record as { uploaderUserId?: Types.ObjectId | null } | null)
      ?.uploaderUserId;
    const isOwner = !!recordedUploader && String(recordedUploader) === String(requesterUserId);
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You do not have permission to delete this file');
    }

    // ── Physical delete (tolerate an already-removed object) ────────────────
    try {
      await this.storageService.deleteFile(fileUrl);
    } catch (err) {
      // File might already be deleted at the storage layer — tolerate and
      // continue to the bookkeeping below. Auth errors above are unaffected.
      // Log for drift visibility (a real storage outage hides here otherwise);
      // key/last-segment only, never the full URL (no PII).
      this.logger.warn(
        `storage deleteFile tolerated (user delete) for "${fileKeyHint(fileUrl)}": ${errMessage(err)}`,
      );
    }

    // ── Quota refund, derived from the record; gated on the row still being
    // live so a repeated delete can never double-refund. ───────────────────
    const recordDeletedAt = (record as { deletedAt?: Date | null } | null)?.deletedAt;
    if (record && recordDeletedAt == null) {
      const size = (record as { fileSizeBytes?: number }).fileSizeBytes ?? 0;
      const recordWorkspaceId = (record as { workspaceId?: Types.ObjectId | null }).workspaceId;
      if (recordWorkspaceId && size > 0) {
        await this.decrementStorageUsage(recordWorkspaceId, size);
      }
      await this.markUploadEventDeleted(fileUrl);
    }
  }

  /**
   * Trusted server-side delete for cascade cleanups (team member removal,
   * bill invoice replacement, document deletion). No caller-ownership check:
   * these run inside already-authorized service flows, not on direct user
   * request. Pass workspaceId + fileSizeBytes to refund the workspace counter;
   * without them the file is deleted but the counter stays unchanged.
   */
  async deleteFile(
    fileUrl: string,
    workspaceId?: string | Types.ObjectId,
    fileSizeBytes?: number,
  ): Promise<void> {
    try {
      await this.storageService.deleteFile(fileUrl);
      if (workspaceId && fileSizeBytes && fileSizeBytes > 0) {
        await this.decrementStorageUsage(workspaceId, fileSizeBytes);
      }
      // Mark UploadEvent deleted by URL — independent of whether the caller
      // passed workspaceId/fileSizeBytes. Recompute relies on this.
      await this.markUploadEventDeleted(fileUrl);
    } catch (err) {
      // Trusted cascade delete -- tolerate an already-removed object so a
      // cleanup never throws. Log for drift visibility (key/last-segment only).
      this.logger.warn(
        `storage deleteFile tolerated (cascade) for "${fileKeyHint(fileUrl)}": ${errMessage(err)}`,
      );
    }
  }

  /**
   * Release a file's storage quota WITHOUT deleting the physical object.
   * Used when a record is soft-deleted but its files must be retained for
   * future recovery: the user stops being charged for the bytes, the upload
   * event is marked deleted so recompute stays correct, but the object stays.
   */
  async releaseFileFromQuota(
    fileUrl: string,
    workspaceId?: string | Types.ObjectId,
  ): Promise<void> {
    try {
      // Only act on a live (not-yet-released) event, so a second call for the
      // same file is a true no-op and never double-refunds the workspace
      // counter. Mirrors markUploadEventDeleted's own `deletedAt: null` gate.
      const event = await this.uploadEventModel.findOne({ fileUrl, deletedAt: null }).lean().exec();
      if (!event) return;
      const size = (event as { fileSizeBytes?: number } | null)?.fileSizeBytes ?? 0;
      if (workspaceId && size > 0) {
        await this.decrementStorageUsage(workspaceId, size);
      }
      await this.markUploadEventDeleted(fileUrl);
    } catch (err) {
      // Best-effort: a quota-release failure must never block the delete. Log so
      // a persistent failure (which would leave the workspace counter inflated)
      // is visible; key/last-segment only, never the full URL.
      this.logger.warn(`quota release tolerated for "${fileKeyHint(fileUrl)}": ${errMessage(err)}`);
    }
  }

  /**
   * Whether a file URL / ref still has a backing object in the ACTIVE storage
   * provider (the same one uploads land on). Thin pass-through to the storage
   * adapter's `objectExists`; returns null when existence is indeterminate.
   * Consumed by the storage-orphan reconcile cron (report-only) -- no hot path.
   */
  async objectExists(fileUrl: string): Promise<boolean | null> {
    return this.storageService.objectExists(fileUrl);
  }

  /**
   * Insert an ownership / upload record. `workspaceId` is null for Connect and
   * identity (avatar) uploads. Best-effort; never blocks the upload response.
   */
  private async logUploadEvent(
    uploaderUserId: string | Types.ObjectId,
    workspaceId: string | Types.ObjectId | null,
    result: UploadResponseDto,
    category: string,
    mimeType?: string,
    // Server-parsed audio duration (null for non-audio). Persisted so feed /
    // inbox voice notes can override the client's claimed duration at write.
    audioDurationSec?: number | null,
    // Server-parsed video duration (null for non-video). Persisted so a feed
    // video post copies the real duration onto its media item at write time.
    videoDurationSec?: number | null,
  ): Promise<void> {
    try {
      await this.uploadEventModel.create({
        uploaderUserId: this.toObjectId(uploaderUserId),
        workspaceId: workspaceId ? this.toObjectId(workspaceId) : null,
        fileUrl: result.url,
        fileName: result.fileName,
        fileSizeBytes: result.fileSize ?? 0,
        mimeType: mimeType ?? null,
        category,
        audioDurationSec: audioDurationSec ?? null,
        videoDurationSec: videoDurationSec ?? null,
      });
    } catch (err: any) {
      this.logger.error(`Failed to log upload event: ${err?.message}`);
    }
  }

  /** Coerce a string / ObjectId into an ObjectId. */
  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));
  }

  /**
   * Server-side workspace attribution guard. The caller may charge a
   * workspace's storage quota only if they own it or hold an active
   * membership row. Throws 403 otherwise (also when the workspace is unknown).
   */
  private async assertWorkspaceMembership(
    userId: string | Types.ObjectId,
    workspaceId: string | Types.ObjectId,
  ): Promise<void> {
    const uid = this.toObjectId(userId);
    const wsId = this.toObjectId(workspaceId);

    const workspace = await this.workspaceModel.findById(wsId).select('ownerId').lean().exec();
    if (workspace && String((workspace as any).ownerId) === String(uid)) {
      return; // owner
    }

    const member = await this.workspaceMemberModel
      .findOne({ workspaceId: wsId, userId: uid, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!member) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }

  /** Wave 5: soft-delete UploadEvent row by URL. Best-effort. */
  private async markUploadEventDeleted(fileUrl: string): Promise<void> {
    try {
      await this.uploadEventModel.updateMany(
        { fileUrl, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      );
    } catch (err: any) {
      this.logger.error(`Failed to mark upload event deleted: ${err?.message}`);
    }
  }

  /**
   * Wave 5: admin-only true-up for `Workspace.storageUsage.bytes`.
   *
   * Sums fileSizeBytes from non-deleted UploadEvents for the given workspace
   * and `$set`s the result onto the workspace doc. Returns
   * `{ before, after, delta }` for audit logging.
   *
   * Limitation: only counts uploads that went through `uploadSingle()` AFTER
   * Wave 5 deployed (UploadEvent log started then). Pre-Wave-5 files are
   * invisible to this recompute — they remain accounted for via the live
   * counter only. For zero-from-scratch true-up, callers should reset the
   * counter to 0 first, then re-import historical files.
   */
  async recomputeStorageUsage(
    workspaceId: string | Types.ObjectId,
  ): Promise<{ before: number; after: number; delta: number }> {
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(String(workspaceId));

    const ws = await this.workspaceModel
      .findById(wsObjectId)
      .select('storageUsage.bytes')
      .lean()
      .exec();
    if (!ws) {
      throw new BadRequestException(`Workspace not found: ${String(workspaceId)}`);
    }
    const before = (ws as any)?.storageUsage?.bytes ?? 0;

    const agg = await this.uploadEventModel.aggregate([
      { $match: { workspaceId: wsObjectId, deletedAt: null } },
      { $group: { _id: null, total: { $sum: '$fileSizeBytes' } } },
    ]);
    const after = agg[0]?.total ?? 0;

    await this.workspaceModel.updateOne(
      { _id: wsObjectId },
      {
        $set: {
          'storageUsage.bytes': after,
          'storageUsage.lastUpdatedAt': new Date(),
        },
      },
    );

    this.logger.log(
      `recomputeStorageUsage: ws=${String(wsObjectId)} before=${before} after=${after} delta=${after - before}`,
    );
    return { before, after, delta: after - before };
  }

  /** Wave 5: bulk recompute across every workspace. Returns per-workspace counts. */
  async recomputeAllStorageUsage(): Promise<{
    workspacesProcessed: number;
    totalDelta: number;
  }> {
    const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();
    let totalDelta = 0;
    for (const ws of workspaces) {
      try {
        const { delta } = await this.recomputeStorageUsage(ws._id);
        totalDelta += delta;
      } catch (err: any) {
        this.logger.error(`recomputeAllStorageUsage: ws=${String(ws._id)} failed: ${err?.message}`);
      }
    }
    return { workspacesProcessed: workspaces.length, totalDelta };
  }

  // ── Storage quota helpers (Wave-3 Drift #36) ───────────────────────────

  /**
   * Check if a file of `incomingBytes` bytes can be uploaded to the workspace.
   * Returns { allowed, reason, ... } without throwing. Use for fire-and-forget paths.
   */
  async checkStorageQuota(
    workspaceId: string | Types.ObjectId,
    incomingBytes: number,
    _incomingMime?: string,
  ): Promise<StorageQuotaResult> {
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(workspaceId);

    const workspace = await this.workspaceModel
      .findById(wsObjectId)
      .select('ownerId storageUsage')
      .lean()
      .exec();

    if (!workspace) {
      return {
        allowed: false,
        reason: 'Workspace not found',
        totalGbPerWorkspace: 0,
        perFileMaxMb: 0,
        currentBytes: 0,
      };
    }

    // Owner subscription lookup → resolve storage entitlements
    let totalGbPerWorkspace = 0.1; // Free default
    let perFileMaxMb = 1; // Free default
    if (workspace.ownerId) {
      const ownerObjectId =
        workspace.ownerId instanceof Types.ObjectId
          ? workspace.ownerId
          : new Types.ObjectId(String(workspace.ownerId));
      const sub = await this.subscriptionModel
        .findOne({ userId: ownerObjectId, status: { $in: ['active', 'trial'] } })
        .select('appliedEntitlements.storage')
        .lean()
        .exec();
      const storage = (sub?.appliedEntitlements as any)?.storage;
      if (storage) {
        if (typeof storage.totalGbPerWorkspace === 'number') {
          totalGbPerWorkspace = storage.totalGbPerWorkspace;
        }
        if (typeof storage.perFileMaxMb === 'number') {
          perFileMaxMb = storage.perFileMaxMb;
        }
      }
    }

    const currentBytes = (workspace as any)?.storageUsage?.bytes ?? 0;

    // Per-file size cap (MB)
    if (perFileMaxMb > 0 && incomingBytes > perFileMaxMb * BYTES_PER_MB) {
      return {
        allowed: false,
        reason: `File exceeds per-file maximum (${perFileMaxMb} MB) for your plan`,
        totalGbPerWorkspace,
        perFileMaxMb,
        currentBytes,
      };
    }

    // Total workspace cap (GB). -1 = unlimited.
    if (totalGbPerWorkspace !== -1) {
      const capBytes = totalGbPerWorkspace * BYTES_PER_GB;
      if (currentBytes + incomingBytes > capBytes) {
        return {
          allowed: false,
          reason: `Workspace storage limit reached (${totalGbPerWorkspace} GB). Used: ${(currentBytes / BYTES_PER_GB).toFixed(2)} GB`,
          totalGbPerWorkspace,
          perFileMaxMb,
          currentBytes,
        };
      }
    }

    return {
      allowed: true,
      totalGbPerWorkspace,
      perFileMaxMb,
      currentBytes,
    };
  }

  /**
   * Enforce storage quota — throws ForbiddenException if exceeded.
   * Use for user-initiated upload flows.
   */
  async enforceStorageQuota(
    workspaceId: string | Types.ObjectId,
    incomingBytes: number,
    incomingMime?: string,
  ): Promise<void> {
    const result = await this.checkStorageQuota(workspaceId, incomingBytes, incomingMime);
    if (!result.allowed) {
      throw new ForbiddenException({
        message: result.reason || 'Storage quota exceeded',
        code: 'STORAGE_QUOTA_EXCEEDED',
        totalGbPerWorkspace: result.totalGbPerWorkspace,
        perFileMaxMb: result.perFileMaxMb,
        currentBytes: result.currentBytes,
      });
    }
  }

  /**
   * Atomically add bytes to workspace.storageUsage.bytes.
   * Call AFTER a successful upload.
   */
  async incrementStorageUsage(workspaceId: string | Types.ObjectId, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(workspaceId);
    await this.workspaceModel.updateOne(
      { _id: wsObjectId },
      {
        $inc: { 'storageUsage.bytes': bytes },
        $set: { 'storageUsage.lastUpdatedAt': new Date() },
      },
    );
  }

  /**
   * Atomically subtract bytes from workspace.storageUsage.bytes.
   * Floors to 0 to prevent negative usage from accounting drift.
   * Call AFTER a successful file delete.
   */
  async decrementStorageUsage(workspaceId: string | Types.ObjectId, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(workspaceId);

    // Decrement, clamping to >= 0
    const ws = await this.workspaceModel
      .findById(wsObjectId)
      .select('storageUsage.bytes')
      .lean()
      .exec();
    const current = (ws as any)?.storageUsage?.bytes ?? 0;
    const next = Math.max(0, current - bytes);
    await this.workspaceModel.updateOne(
      { _id: wsObjectId },
      {
        $set: {
          'storageUsage.bytes': next,
          'storageUsage.lastUpdatedAt': new Date(),
        },
      },
    );
  }

  // ── Validation ─────────────────────────────────────────────────────────

  /**
   * Per-category file validation. Delegates to the layered policy in
   * `upload-policies.ts` (global → category → future plan-tier override).
   * The category is passed so the right size + MIME limits apply — earlier
   * this used a single global cap that gave a 50 MB feed video the same
   * limits as a 2 MB avatar. Falls back to the global env-var cap when
   * called via the legacy path (no category resolution possible).
   */
  private validateFileWithCategory(file: any, category: UploadCategory): void {
    const policy = resolveUploadPolicy(category);
    const violation = checkUploadPolicy(file, policy);
    if (violation) {
      throw new BadRequestException(violation.message);
    }

    // Defence-in-depth — also honour the env-var floor so an env-driven
    // ops cap (smaller than the policy) still wins.
    if (file && this.maxFileSize && file.size > this.maxFileSize) {
      throw new BadRequestException(
        `File size exceeds the global limit of ${this.maxFileSize / 1024 / 1024} MB`,
      );
    }
  }

  /**
   * Magic-byte content validation. Reads the real format from `file.buffer`
   * (multer memory storage) and rejects when the detected type is not allowed
   * by the category policy, or disagrees with the declared mime across format
   * families. Delegates the decision to `content-sniffer.ts`; throws a
   * `BadRequestException` with a message styled to match `checkUploadPolicy`.
   *
   * Skips silently when no in-memory buffer is present (e.g. a future disk- or
   * stream-backed multer config) — without the bytes there is nothing to sniff,
   * and the declared-mime guard in `validateFileWithCategory` has already run.
   */
  private async validateFileContent(file: any, category: UploadCategory): Promise<void> {
    const buffer: unknown = file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;

    const policy = resolveUploadPolicy(category);
    const violation = await sniffAndCheck(buffer, file?.mimetype, policy);
    if (violation) {
      throw new BadRequestException(violation.message);
    }
  }

  /**
   * Media-constraint validation — audio duration + image dimensions. Reads the
   * real values from `file.buffer` (multer memory storage) via `media-probe`
   * and rejects when they break the category policy:
   *  - images (`image/*`): edge / megapixel decompression-bomb ceilings,
   *    per-category aspect ratio, and unreadable-header rejection;
   *  - audio (`audio/*`) in a duration-capped category: clip longer than the
   *    cap (+tolerance), or an unparseable duration (fail closed).
   *
   * Returns the server-parsed audio / video duration (or null) so the caller
   * persists it as the source of truth. Skips silently when no in-memory buffer
   * is present, mirroring `validateFileContent`.
   *  - audio (`audio/*`) in a duration-capped category: as before;
   *  - video (`video/*`) in a duration-capped category (`connect-posts` ->
   *    feed cap 120s): over-cap or unparseable-duration clips are rejected
   *    (fail closed), exactly like audio.
   */
  private async validateMediaConstraints(
    file: any,
    category: UploadCategory,
  ): Promise<{ audioDurationSec: number | null; videoDurationSec: number | null }> {
    const empty = { audioDurationSec: null, videoDurationSec: null };
    const buffer: unknown = file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return empty;

    const policy = resolveUploadPolicy(category);
    const declared = typeof file?.mimetype === 'string' ? file.mimetype.toLowerCase() : '';

    // Image sanity — dimensions, decompression-bomb guard, aspect ratio.
    if (declared.startsWith('image/')) {
      const violation = probeAndCheckImage(buffer, policy);
      if (violation) throw new BadRequestException(violation.message);
    }

    // Audio duration — only for categories that cap it, and only audio files.
    // (A mixed category like `connect-inbox-media` allows both images and
    // audio; an image upload there skips this branch.)
    let audioDurationSec: number | null = null;
    if (policy.duration && declared.startsWith('audio/')) {
      const { violation, durationSec } = await probeAndCheckAudio(buffer, declared, policy);
      if (violation) throw new BadRequestException(violation.message);
      audioDurationSec = durationSec;
    }

    // Video duration — same gate, for video files in a duration-capped category
    // (feed posts -> `connect-posts` caps video at 120s; images/docs in that
    // same category skip this branch).
    let videoDurationSec: number | null = null;
    if (policy.duration && declared.startsWith('video/')) {
      const { violation, durationSec } = await probeAndCheckVideo(buffer, declared, policy);
      if (violation) throw new BadRequestException(violation.message);
      videoDurationSec = durationSec;
    }

    return { audioDurationSec, videoDurationSec };
  }

  private validateCategory(category: string): asserts category is UploadCategory {
    if (!UPLOAD_CATEGORIES.includes(category as UploadCategory)) {
      throw new BadRequestException(`Invalid category. Allowed: ${UPLOAD_CATEGORIES.join(', ')}`);
    }
  }
}
