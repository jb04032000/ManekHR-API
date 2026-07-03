import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * A single admin-managed legal/policy document (Terms or Privacy, per product).
 * Authored as Markdown in the admin console; the public marketing routes render
 * the PUBLISHED version only (drafts never leak).
 *
 * Cross-module links:
 *   - Admin CRUD: legal-pages.admin.controller -> LegalPagesService (IsAdminGuard).
 *   - Public read: legal-pages.public.controller GET /legal-pages/:slug (@Public).
 *   - Web renders these at /terms/{connect,erp} + /privacy/{connect,erp}
 *     (crewroster-web app/(marketing)). Keep `slug` in sync with those routes.
 *   - Seeded as 4 drafts by migration 0047 (seed-legal-pages) so the public
 *     routes always have a row to resolve to (placeholder fallback until publish).
 */
@Schema({ timestamps: true })
export class LegalPage extends Document {
  /**
   * Stable public identifier the web routes fetch by. One per product+kind:
   * `terms-connect` | `terms-erp` | `privacy-connect` | `privacy-erp`.
   * Unique so a product/kind has exactly one document.
   */
  @Prop({ required: true, unique: true, index: true })
  slug: string;

  /**
   * Which scope this document governs:
   *   platform = company-wide canonical doc (the footer links here; /terms, /privacy)
   *   connect / erp = product-specific document (/terms/connect, /privacy/erp, ...)
   * Mirrors the "company-wide website terms + product-specific agreements" pattern.
   */
  @Prop({ type: String, required: true, enum: ['platform', 'connect', 'erp'], index: true })
  product: string;

  /**
   * Document kind. `guidelines` = Community Guidelines (the UGC code of conduct
   * required for Google AdSense approval; rendered at /guidelines/{connect,erp}).
   * `kind` leaves room to add cookie/refund docs later (YAGNI now).
   */
  @Prop({ type: String, required: true, enum: ['terms', 'privacy', 'guidelines'] })
  kind: string;

  @Prop({ required: true })
  title: string;

  /** Markdown body authored by the admin. Empty until first edit. */
  @Prop({ default: '' })
  body: string;

  /**
   * Only `published` documents are served publicly. New/edited content sits in
   * `draft` until an admin publishes it.
   */
  @Prop({
    type: String,
    required: true,
    enum: ['draft', 'published'],
    default: 'draft',
    index: true,
  })
  status: string;

  /** Bumped on every publish so the FE / audit trail can show "version N". */
  @Prop({ required: true, default: 1 })
  version: number;

  /** Optional "effective from" date the admin can show on the public page. */
  @Prop({ type: Date })
  effectiveDate?: Date;
}

export const LegalPageSchema = SchemaFactory.createForClass(LegalPage);
