import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Per-upload event log. Source of truth for `Workspace.storageUsage.bytes`
 * recomputation when the live counter drifts (e.g. delete callers that don't
 * pass `fileSizeBytes`, or pre-Wave-3 uploads that were never tracked).
 *
 * Lifecycle:
 *   - Upload success → insert with deletedAt = null.
 *   - Delete success → set deletedAt = now (soft delete; row kept for audit).
 *
 * Recompute:
 *   sum(fileSizeBytes) where workspaceId = ? and deletedAt = null.
 */
export type UploadEventDocument = UploadEvent & Document;

@Schema({ timestamps: true })
export class UploadEvent extends Document {
  /**
   * Owning user — the authenticated uploader (`req.user.sub`). Source of
   * truth for ownership-checked delete and for the per-USER Connect storage
   * quota (sum of non-deleted `connect-*` rows per uploader). Indexed.
   * Nullable only for pre-change rows that predate ownership tracking.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  uploaderUserId?: Types.ObjectId | null;

  /**
   * Workspace charged for the upload. Nullable: Connect uploads
   * (categories prefixed `connect-`) are person-centric and pass no
   * workspace, so the field is null and the workspace recompute simply
   * ignores those rows.
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null, index: true })
  workspaceId?: Types.ObjectId | null;

  /** Public URL returned by storage adapter. Used as the delete-time lookup key. */
  @Prop({ required: true, index: true })
  fileUrl: string;

  /** Storage-side filename (post-randomisation). For audit + admin debugging. */
  @Prop({ required: true })
  fileName: string;

  @Prop({ required: true, min: 0 })
  fileSizeBytes: number;

  @Prop()
  mimeType?: string;

  @Prop()
  category?: string;

  /**
   * Server-parsed audio duration in seconds (read from the buffer header by
   * `media-probe` at upload time). Source of truth that OVERRIDES the
   * client-claimed duration when a feed voice post / inbox voice note is
   * persisted -- see `media-ownership.service.ts` `getServerAudioDurationByUrl`.
   * Null for non-audio uploads and for rows that predate this field.
   */
  @Prop({ type: Number, default: null, min: 0 })
  audioDurationSec?: number | null;

  /**
   * Server-parsed VIDEO duration in seconds (read from the container header by
   * `media-probe` at upload time). Mirror of `audioDurationSec` for the feed
   * video path: it is copied onto the post `media[]` item at create time (see
   * `media-ownership.service.ts` `getServerVideoDurationByUrl`) so a forged
   * client duration is never persisted. Null for non-video uploads and rows
   * that predate this field.
   */
  @Prop({ type: Number, default: null, min: 0 })
  videoDurationSec?: number | null;

  /** Soft-delete marker. Recompute filters on `deletedAt: null`. */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const UploadEventSchema = SchemaFactory.createForClass(UploadEvent);

// Compound index for fast recompute queries.
UploadEventSchema.index({ workspaceId: 1, deletedAt: 1 });

// Compound index for the per-USER Connect storage-usage aggregate
// (sum of non-deleted `connect-*` rows for one uploader).
UploadEventSchema.index({ uploaderUserId: 1, deletedAt: 1 });
