import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * ConnectBanner — an admin-curated promotional banner shown in the Connect feed
 * carousel (between the composer and the module tabs). Platform-level content
 * (no workspace tenant): every banner is created by a platform admin and shown
 * to all feed viewers, so there is no `workspaceId` here.
 *
 * Image handling: `imageUrl` stores the CANONICAL upload value — either a
 * public URL or a private `r2-private://<key>` ref (uploads' private-R2 signed-
 * URL policy). The public read path (banner.service.listActive) decorates it
 * through `PrivateMediaService` into a fresh short-lived signed URL; the raw
 * ref is never handed to the client.
 *
 * Live window: `liveFrom` / `liveUntil` are OPTIONAL (null = unbounded that
 * side). The public filter (see banner-live-window.ts `isBannerLive`) requires
 * `isActive` AND now inside [liveFrom, liveUntil]. Cross-links:
 * banner.service.ts, banner-admin.controller.ts, banner-public.controller.ts.
 */
@Schema({ timestamps: true, collection: 'connect_banners' })
export class ConnectBanner extends Document {
  /** Canonical image value: public URL or `r2-private://<key>` ref. Required. */
  @Prop({ type: String, required: true, trim: true })
  imageUrl: string;

  /** Optional click-through target. Empty = the banner is not clickable. */
  @Prop({ type: String, trim: true, default: '' })
  linkUrl: string;

  /** Human label (admin table) — also the default alt text if `alt` is blank. */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title: string;

  /** Accessibility alt text for the image. Falls back to `title` when blank. */
  @Prop({ type: String, trim: true, maxlength: 200, default: '' })
  alt: string;

  /** Sort order within the carousel (ascending). Lower shows first. */
  @Prop({ type: Number, default: 0 })
  order: number;

  /** Master on/off. Only active banners can be live (see live-window filter). */
  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  /** Optional window start. Null = live since forever. */
  @Prop({ type: Date, default: null })
  liveFrom: Date | null;

  /** Optional window end. Null = live until forever. */
  @Prop({ type: Date, default: null })
  liveUntil: Date | null;

  // `createdAt` / `updatedAt` added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectBannerDocument = ConnectBanner & Document;

export const ConnectBannerSchema = SchemaFactory.createForClass(ConnectBanner);

// Public read rides `{ isActive: 1, order: 1 }`: filter active + sort by order.
ConnectBannerSchema.index({ isActive: 1, order: 1 });
