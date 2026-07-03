import { IsMongoId } from 'class-validator';

/**
 * Body for `POST /connect/ads/hide` (Phase 7d) — a reader hid a sponsored post.
 * The winning campaign id comes from the decision result the slot was rendered
 * with. Recording it stops that campaign serving to THIS viewer (the ad-side
 * equivalent of feed `not_interested`).
 */
export class HideAdDto {
  @IsMongoId()
  campaignId!: string;
}
