import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * One @mention (tag) embedded in a post or comment body (Connect feed).
 * What it does: carries a resolved, link-ready reference to a tagged entity.
 * The body keeps the literal "@<display>" text; this sub-doc lets the renderer
 * order-match each "@<display>" occurrence to a chip (chips are atomic in the
 * composer, so the body always contains the exact token - no char offsets).
 * Cross-module: refId points at a User (profile) / CompanyPage / Storefront;
 * href is the precomputed public route the chip links to (computed server-side,
 * never trusted from the client). Shared by post.schema + comment.schema.
 * Watch: display + href are snapshots; a later rename/delete is handled at
 * render time (stale display renders, dead href degrades to plain text on FE).
 */
export const MENTION_TYPES = ['profile', 'company', 'storefront'] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

@Schema({ _id: false })
export class Mention {
  @Prop({ type: String, enum: MENTION_TYPES, required: true })
  type: MentionType;

  @Prop({ type: Types.ObjectId, required: true })
  refId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  display: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  href: string;
}
export const MentionSchema = SchemaFactory.createForClass(Mention);
