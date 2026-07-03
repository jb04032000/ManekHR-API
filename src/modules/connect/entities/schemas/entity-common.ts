import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * ManekHR Connect -- shared building blocks for the owned business entities
 * (CompanyPage + Storefront, Phase 4/6). Both are parallel sibling entities per
 * `docs/connect/IDENTITY-MODEL.md`: person-centric (`ownerUserId`, never a
 * workspace), public-by-slug, with an OPTIONAL per-entity ERP link.
 *
 * Every `@Prop` carries an explicit `{ type }` -- required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass` resolves
 * without `emitDecoratorMetadata`.
 */

/**
 * Public exposure of an owned entity. Mirrors `ConnectProfile.visibility`:
 *  - `public`      -- indexable, anyone (incl. logged-out) sees it.
 *  - `connections` -- restricted view to non-authorized viewers.
 *  - `hidden`      -- 404 to anyone but the owner.
 */
export const ENTITY_VISIBILITIES = ['public', 'connections', 'hidden'] as const;
export type EntityVisibility = (typeof ENTITY_VISIBILITIES)[number];

/**
 * Where the business is based. `district` is the primary geo filter (mirrors the
 * marketplace `ListingLocation`); `city` + `state` refine it. All optional.
 */
@Schema({ _id: false })
export class EntityLocation {
  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  district: string;

  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  city: string;

  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  state: string;
}
export const EntityLocationSchema = SchemaFactory.createForClass(EntityLocation);
